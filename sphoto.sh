#!/bin/sh
# SPhoto - executor unico (Linux). Mesmo papel do iniciar-tudo.vbs no Windows.
cd "$(dirname "$0")"
node launcher.js
