# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2025-08-10

### Changed
- Standardized all naming and commands to "Notebook Slide Preview" for better consistency throughout the user interface.

## [1.0.1] - 2025-08-09

### Changed
- Updated the extension's display name to "Notebook Slide Preview" for clarity.

### Added
- Added an official logo to the extension.
- Added keywords to `package.json` to improve discoverability in the Marketplace.

## [1.0.0] - 2025-08-08

### Added

- **Initial Release** of the  Notebook Slide Preview extension.
- Interactive slide-show style editor for `.ipynb` files.
- Full code execution with outputs displayed directly in the slide.
- Custom, distraction-free "Presentation Mode" that hides all VS Code UI chrome.
- Main toolbar with global actions: Run All, Restart Kernel, Clear All Outputs, Undo, and Redo.
- Per-slide toolbars for running and deleting individual cells.
- Double-click to edit Markdown cells.
- Keyboard shortcuts for navigation (`←`/`→`) and execution (`Cmd/Ctrl+Enter`).
- Execution count display (`[1]`, `[2]`, etc.) for code cells.
- Theme-aware UI that adapts to Light, Dark, and High Contrast themes.
- "Open with Slide Preview" button in the native notebook toolbar for easy discoverability.

[1.0.0]: https://github.com/GeorgiaDimaki/ipynb-slide-preview/releases/tag/v1.0.0
[1.0.1]: https://github.com/GeorgiaDimaki/ipynb-slide-preview/compare/v1.0.0...v1.0.1
[1.0.2]: https://github.com/GeorgiaDimaki/ipynb-slide-preview/compare/v1.0.1...v1.0.2