#!/bin/sh
# Example helper copied into the image from the build context.
set -eu
echo "project tools ready: $(gh --version | head -n1)"
