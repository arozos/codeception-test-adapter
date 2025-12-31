# Change Log

All notable changes to the "Codeception Test Explorer" extension will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2025-12-31

### Added
- **Auto-discovery of test suites**: Extension now automatically discovers all test suites from the `tests/` directory
- Support for custom test suites (e.g., `integration`, `api`, etc.) without manual configuration
- **Docker environment variables**: New `codeceptionphp.docker.env` setting to pass custom environment variables to Docker containers (e.g., database credentials)
- **Group/Tag filtering**: New `codeceptionphp.groups.include` and `codeceptionphp.groups.exclude` settings to filter tests by Codeception groups
- Support for VSCode's native tag filtering in Test Explorer UI
- Automatic parsing of `@group` annotations and display as tags in Test Explorer

### Changed
- Default `codeceptionphp.suites` configuration is now empty array `[]` to enable auto-discovery
- Improved suite discovery logging for better debugging
- Docker command building now supports multiple environment variables with automatic filtering of empty values
- Test commands now include `--group` and `--skip-group` flags when group filters are configured

## [0.2.1] - 2025-12-31

### Internal
- Version bump for development

## [0.2.0] - 2025-11-30

### Added
- Docker container support for running tests inside containers
- Automatic Docker working directory detection
- Code coverage support with visualization
- Coverage manager for test execution with coverage enabled
- Command: "Run From Docker..." to select and configure Docker containers
- Configuration options for Docker (enabled, container, workdir)
- Configuration option for always running tests with coverage
- esbuild bundling for proper VSIX packaging

### Changed
- Improved test discovery and parsing
- Enhanced error handling and logging
- Better output channel integration for debugging
- Migrated from TypeScript compilation to esbuild bundling for production builds

### Fixed
- Test execution reliability improvements
- Parser handling for various Codeception test formats
- **Critical**: Fixed extension not loading when installed from VSIX due to missing bundled dependencies

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

