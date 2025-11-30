# Change Log

All notable changes to the "Codeception Test Explorer" extension will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-11-30

### Added
- Docker container support for running tests inside containers
- Automatic Docker working directory detection
- Code coverage support with visualization
- Coverage manager for test execution with coverage enabled
- Command: "Run From Docker..." to select and configure Docker containers
- Configuration options for Docker (enabled, container, workdir)
- Configuration option for always running tests with coverage

### Changed
- Improved test discovery and parsing
- Enhanced error handling and logging
- Better output channel integration for debugging

### Fixed
- Test execution reliability improvements
- Parser handling for various Codeception test formats

## [0.1.0] - Initial Release

### Added
- Native VSCode Test Explorer integration
- Automatic test discovery for Test, Cest, and Cept files
- Support for running individual tests, files, and suites
- Test organization by Codeception suites (unit, functional, acceptance)
- Auto-refresh on file save
- CodeLens integration for running tests from code
- Configuration options for binary path, arguments, and config file
- Support for custom test suites configuration

