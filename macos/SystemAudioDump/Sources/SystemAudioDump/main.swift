import Foundation
import AVFoundation
@preconcurrency import ScreenCaptureKit
import CoreMedia

private func logStatus(_ message: String) {
  fputs("\(message)\n", Darwin.stderr)
}

@main
struct SystemAudioDump {
  static func main() async {
    do {
      logStatus("Starting SystemAudioDump...")

      // Check if we have screen recording permission
      logStatus("Checking permissions...")
      let canRecord = CGPreflightScreenCaptureAccess()
      if !canRecord {
        logStatus("❌ Screen recording permission required!")
        logStatus("Please go to System Preferences > Security & Privacy > Privacy > Screen Recording")
        logStatus("and enable access for this application.")

        // Request permission
        let granted = CGRequestScreenCaptureAccess()
        if !granted {
          logStatus("Permission denied. Exiting.")
          exit(1)
        }
      }
      logStatus("✅ Permissions OK")

      // 1) Grab shareable content
      logStatus("Getting shareable content...")
      let content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                        onScreenWindowsOnly: true)
      guard let display = content.displays.first else {
        fatalError("No display found")
      }
      logStatus("Found display: \(display)")

      // 2) Build a filter for that display (video is ignored below)
      let filter = SCContentFilter(display: display,
                                   excludingApplications: [], // don't exclude any
                                   exceptingWindows: [])
      logStatus("Created filter")

      // 3) Build a stream config that only captures audio
      let cfg = SCStreamConfiguration()
      cfg.capturesAudio = true
      cfg.captureMicrophone = false
      cfg.excludesCurrentProcessAudio = true  // don't capture our own output
      logStatus("Created configuration")

      // 4) Create and start the stream
      let dumper = AudioDumper()
      let stream = SCStream(filter: filter,
                            configuration: cfg,
                            delegate: dumper)
      logStatus("Created stream")

      // only install audio output
      try stream.addStreamOutput(dumper,
                                 type: .audio,
                                 sampleHandlerQueue: DispatchQueue(label: "audio"))
      logStatus("Added stream output")

      try await stream.startCapture()
      logStatus("Started capture")

      logStatus("✅ Capturing system audio. Press ⌃C to stop.")

      // keep the process alive with a safer approach
      logStatus("Entering main loop...")

      // Set up signal handling for graceful shutdown
      signal(SIGINT) { _ in
        logStatus("Received SIGINT, shutting down...")
        exit(0)
      }

      // Keep alive with a simple loop instead of dispatchMain
      while true {
        try await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
      }

    } catch {
      fputs("Error: \(error)\n", Darwin.stderr)
      exit(1)
    }
  }
}

/// A simple SCStreamOutput + SCStreamDelegate that converts to 24 kHz Int16 PCM and writes to stdout
final class AudioDumper: NSObject, SCStreamDelegate, SCStreamOutput {
  // We'll hold a converter from native rate to 24 kHz, 16-bit, interleaved.
  private var converter: AVAudioConverter?
  private var outputFormat: AVAudioFormat?

  func stream(_ stream: SCStream,
              didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
              of outputType: SCStreamOutputType) {
    guard outputType == .audio else { return }

    // Wrap the CMSampleBuffer in an AudioBufferList
    do {
      try sampleBuffer.withAudioBufferList { abl, _ in
        guard let desc = sampleBuffer.formatDescription?.audioStreamBasicDescription else {
          return
        }

        // Initialize converter on first buffer
        if converter == nil {
          // source format
          guard let srcFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                            sampleRate: desc.mSampleRate,
                                            channels: desc.mChannelsPerFrame,
                                            interleaved: false) else {
            fputs("Failed to create source format\n", Darwin.stderr)
            return
          }
          // target: 24 kHz, Int16 interleaved
          guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                               sampleRate: 24_000,
                                               channels: desc.mChannelsPerFrame,
                                               interleaved: true) else {
            fputs("Failed to create target format\n", Darwin.stderr)
            return
          }
          outputFormat = targetFormat
          converter = AVAudioConverter(from: srcFormat, to: targetFormat)
        }

        guard let converter = converter,
              let outFmt = outputFormat else { return }

        // Create source AVAudioPCMBuffer
        let srcFmt = converter.inputFormat
        guard let srcBuffer = AVAudioPCMBuffer(pcmFormat: srcFmt,
                                               frameCapacity: AVAudioFrameCount(sampleBuffer.numSamples)) else {
          return
        }
        srcBuffer.frameLength = srcBuffer.frameCapacity

        // Safely copy from AudioBufferList
        guard srcBuffer.floatChannelData != nil else { return }

        let channelCount = min(Int(srcFmt.channelCount), abl.count)
        for i in 0..<channelCount {
          guard i < abl.count,
                let channelData = srcBuffer.floatChannelData?[i],
                let bufferData = abl[i].mData else { continue }

          let bytesToCopy = min(Int(abl[i].mDataByteSize),
                               Int(srcBuffer.frameCapacity) * MemoryLayout<Float>.size)
          memcpy(channelData, bufferData, bytesToCopy)
        }

        // Create output buffer with proper capacity calculation
        let outputFrameCapacity = AVAudioFrameCount(ceil(Double(srcBuffer.frameLength) * outFmt.sampleRate / srcFmt.sampleRate))
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFmt,
                                             frameCapacity: outputFrameCapacity) else {
          return
        }

        // Perform conversion
        var error: NSError?
        let status = converter.convert(to: outBuffer,
                                       error: &error) { _, outStatus in
          outStatus.pointee = .haveData
          return srcBuffer
        }

        guard status != .error,
              outBuffer.frameLength > 0,
              let int16Data = outBuffer.int16ChannelData?[0] else {
          if let error = error {
            fputs("Conversion error: \(error)\n", Darwin.stderr)
          }
          return
        }

        // Write raw bytes to stdout
        let byteCount = Int(outBuffer.frameLength) * Int(outFmt.streamDescription.pointee.mBytesPerFrame)
        let data = Data(bytes: int16Data, count: byteCount)
        FileHandle.standardOutput.write(data)
      }
    } catch {
      fputs("Audio processing error: \(error)\n", Darwin.stderr)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fputs("Stream stopped with error: \(error)\n", Darwin.stderr)
  }
}
