# Rsync source snapshots must exclude env files

## Context

A source snapshot sync excluded Git, dependencies, and build output but did not exclude ignored `.env*` files. The repository's `.dockerignore` would have kept `.env.local` out of images, yet the remote source snapshot still contained an unnecessary secret-bearing copy.

## Rule

Every repository-to-remote `rsync` command must explicitly exclude `.env`, `.env.*`, key/certificate formats, dumps, and local backup directories in addition to Git, dependencies, and build output. Do not rely on Git ignore or Docker ignore to protect the remote source snapshot. If a copy is detected, remove only the exact remote duplicate before building and verify no matching file remains.
