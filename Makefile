SHELL := /bin/bash

.PHONY: help deps dev stop test build render-latest install-fonts install-browser

help:
	@echo "Primary targets:"
	@echo "  make dev             Run the standalone browser UI for local development/debugging"
	@echo "  make stop            Best-effort stop for the standalone 'make dev' server only"
	@echo "  make test            Run the Node test suite"
	@echo "  make build           Package the VS Code extension as a .vsix"
	@echo "  make help            Show this command summary"
	@echo ""
	@echo "Host-first workflow:"
	@echo "  Day-to-day usage stays in VS Code via: Codex Session Renderer: Open Session Browser"
	@echo ""
	@echo "Other targets:"
	@echo "  make deps            Install npm dependencies"
	@echo "  make render-latest   Export the latest session snapshot"
	@echo "  make install-fonts   Install pinned Source Han Sans SC font assets"
	@echo "  make install-browser Install Playwright Chromium for PNG export"

deps:
	@npm install

dev:
	@npm run web

stop:
	@if command -v pkill >/dev/null 2>&1; then \
		pkill -f "[n]ode .*src/cli\\.js --serve" || true; \
	else \
		powershell -NoProfile -ExecutionPolicy Bypass -Command \
			'$$patterns = @("node .*src/cli\\.js --serve", "npm(\\.cmd)? run web"); $$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$cmd = $$_.CommandLine; $$cmd -and (($$patterns | Where-Object { $$cmd -match $$_ }).Count -gt 0) }; foreach ($$p in $$procs) { Stop-Process -Id $$p.ProcessId -Force -ErrorAction SilentlyContinue }'; \
	fi

test:
	@npm test

build:
	@npm run package:vsix

render-latest:
	@npm run render -- --latest

install-fonts:
	@npm run install:fonts

install-browser:
	@npm run install:browser
