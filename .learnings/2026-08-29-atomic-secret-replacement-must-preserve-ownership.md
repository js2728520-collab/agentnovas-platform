# Atomic secret replacement must preserve ownership

## Context

The provider installer wrote a protected temporary env file and atomically renamed it over the target. It restored mode `0440`, but the temporary file inherited the invoking process group. Running the installer as root therefore changed `root:1000` files to `root:root`, and non-root containers could no longer read their `/run/secrets/*.env` bind mounts.

## Rule

An atomic secret-file replacement must preserve the target file's numeric owner and group as well as its restrictive mode. Capture ownership before creating the temporary file, apply it before rename, and cover the behavior with a POSIX regression test that gives the fixture a non-default group. After any secret installer run, verify both host ownership and readability from the intended non-root container identity before restarting services.

Local Docker Compose implements file-backed secrets as bind mounts and warns that long-syntax `uid`, `gid`, and `mode` are ignored. A private file at `root:root 0400` therefore appears present in container inspection but is unreadable by a UID 1000 process. For a secret mounted only into one service, use `root:<runtime-gid> 0440` on the host and verify readability as that runtime identity; never solve it with world-readable permissions.

The same applies to one-off `docker run --mount type=bind` validation jobs: a root-owned `0600` temporary env is invisible to a non-root image. Create it as `root:<runtime-gid> 0440`, mount it read-only, and remove the exact temporary path on exit.
