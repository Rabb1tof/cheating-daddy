# SystemAudioDump

This Swift helper captures macOS system audio as interleaved, signed 16-bit, 24 kHz stereo PCM on stdout. The Electron app reads stdout as an audio stream, so this copy sends all diagnostics to stderr. The functional change from the source below is that status messages now use `logStatus`; PCM is the only stdout output.

Source: [Mohammed-Yasin-Mulla/Sound](https://github.com/Mohammed-Yasin-Mulla/Sound), commit `19caa4f6c0661c03a10d1f08c79a11f0b00f251a`. Copyright (c) 2025 Mohammed Yasin Mulla. Licensed under MIT; see [LICENSE](LICENSE).

The current package targets macOS 15 or newer. The application release bundles an Apple Silicon (`arm64`) build. Build it on macOS with Xcode/Swift 6 or newer before packaging the Electron app:

```sh
swift build -c release --package-path macos/SystemAudioDump
cp "$(swift build -c release --package-path macos/SystemAudioDump --show-bin-path)/SystemAudioDump" src/assets/SystemAudioDump
```

The commands run from the repository root. Check the result with `file src/assets/SystemAudioDump`; it must be an arm64 Mach-O executable for the Apple Silicon release.
