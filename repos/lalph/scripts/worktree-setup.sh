#!/bin/bash

direnv allow
corepack install
pnpm install

git subtree pull -P repos/effect --squash https://github.com/effect-ts/effect-smol.git main
