# Remote host Python does not guarantee `venv`

- Date: 2026-08-29
- Context: preparing a static Client localization catalog on `an-saas`
- Failure: `python3 -m venv` failed because the host Python installation does not include `ensurepip` / `python3-venv`.
- Rule: do not install host packages or assume a writable Python toolchain on `an-saas`; use a pinned, disposable Python container for auxiliary generation work.
- Scope: this affects tooling only. Application builds remain pinned to the Node 22.21+ container.
