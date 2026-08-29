# Nested bind mounts need an existing writable mountpoint

## Context

A one-off migrator mounted a source tree read-only at `/workspace` and then attempted to mount cached `node_modules` at `/workspace/node_modules`. Because that directory did not exist in the source snapshot, the runtime could not create the nested mountpoint under the read-only parent and refused to start the container.

## Rule

Do not layer a dependency bind mount under a read-only source bind unless the nested mountpoint already exists. Prefer a previously synchronized disposable source tree that already contains dependencies, or prepare the exact empty mountpoint before making the parent read-only. A container-start failure must be treated as no migration attempt, then retried with a valid mount layout.
