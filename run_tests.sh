#!/bin/bash
set -e
cd "$(dirname "$0")"
NODE_NO_WARNINGS=1 node --test test/mock.test.js test/http.test.js
