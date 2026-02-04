# Kosmos Panel - Developer Guide for Agentic Coding

This guide provides essential information for AI agents and developers working on the Kosmos Panel codebase.

## Quick Start Commands

### Running the Application
```bash
# Primary way (recommended)
npm start

# Development mode with hot reload
npm run dev

# Alternative using Node.js
npm run start:node

# Run tests (Bun/Node compatible)
bun tests/test_usa_v2.js
# or
node tests/test_usa_v2.js
```

### Running a Single Test
```bash
# Run terminal API v2 test
bun tests/test_usa_v2.js

# Test specific functionality by creating new test files in tests/ directory
```

### Build & Quality Commands
This project uses minimal tooling - no formal build system, linting, or type checking configured.

## Architecture Overview

Kosmos Panel is a Node.js-based server monitoring dashboard with vanilla JavaScript frontend:

**Backend Structure:**
- `server.js` - Main Express server, API routes, static file serving
- `server/monitor.js` - Core monitoring logic, service checks, inventory management
- `server/ws.js` - WebSocket handlers for terminal and log tailing
- `server/terminal.js` - REST API for terminal session management (v1 & v2)
- `server/ws-utils.js` - Shared utilities for SSH operations
- `server/logger.js` - Logging utility with file output

**Frontend Structure:**
- `web/app.js` - Main dashboard UI, terminal management, server actions
- `web/index.html` - Dashboard HTML structure
- `web/term.html` - Standalone terminal page
- `web/inventory-editor.html` - Configuration editor
- `web/styles.css` - Complete styling with CSS variables

## Code Style Guidelines

### JavaScript/Node.js (Backend)

**Imports & Dependencies:**
- Use CommonJS `require()` syntax throughout
- Core Node.js modules imported first, then third-party, then local modules
```javascript
const fs = require('fs');
const path = require('path');
const express = require('express');
const logger = require('./logger');
```

**Formatting & Naming:**
- 2-space indentation
- CamelCase for variables and functions
- PascalCase for constructors/classes
- Use descriptive names for server configurations and service types

**Error Handling:**
- Always include error handling for async operations
- Use try-catch blocks for file operations and network requests
- Log errors with structured context using the logger module
- Return appropriate HTTP status codes (400, 404, 500)

**Configuration Management:**
- Use `.env` for secrets and environment-specific values
- Support `${VAR_NAME}` and `$VAR_NAME` placeholder syntax in inventory.json
- Validate configuration before applying changes
- Create backups before overwriting configuration files

### Frontend (Vanilla JavaScript)

**Code Organization:**
- Use IIFE patterns for module encapsulation
- Event delegation for dynamic content
- Separate DOM manipulation from business logic
- Use modern DOM APIs (querySelector, addEventListener)

**Error Handling:**
- Graceful degradation for WebSocket connections
- User-friendly error messages in UI
- Console logging for debugging

**CSS & Styling:**
- CSS custom properties (variables) for theming
- Mobile-responsive grid layout
- Dark theme by default
- Consistent spacing and border radius

## Key Patterns & Conventions

### Service Monitoring Types
When adding new service types in `monitor.js`:
1. Create `checkServiceType()` function
2. Add to `runServiceCheck()` switch statement
3. Return `{ok: boolean, detail: string}` format
4. Handle timeout and error cases appropriately

### WebSocket Communication
- Use JSON message format with `type` field
- Support data types: `data`, `err`, `fatal`, `ai_query`, `command_log`
- Always handle connection lifecycle (open, message, close, error)
- Include server context in all operations

### Configuration Validation
- Validate required fields (id, type, host, port, etc.)
- Ensure unique IDs for servers and credentials
- Check SSH connectivity before saving configuration
- Provide meaningful error messages for validation failures

### Terminal Management
- Support both WebSocket and REST API approaches
- Maintain session state and cleanup
- Handle terminal resizing properly
- Support AI command processing with `ai:` prefix

## Important Files & Their Roles

### Core Configuration
- `inventory.json` - Server definitions, services, credentials
- `.env` - Environment variables and secrets
- `package.json` - Dependencies and scripts

### API Endpoints (server.js)
- `GET /api/servers` - Current server statuses
- `GET/POST /api/inventory` - Configuration management
- `POST /api/reload` - Hot reload configuration
- `GET /api/test-ssh` - Test SSH connectivity
- `POST /api/v1|v2/terminal/sessions` - Terminal API

### Frontend Components
- Dashboard grid with server tiles and service status
- Modal system for server actions
- Terminal integration using xterm.js
- Configuration editor with validation

## Development Workflow

1. **Testing Changes:** Use `npm run dev` for development with hot reload
2. **Adding Services:** Implement in `server/monitor.js`, then add UI handling in `web/app.js`
3. **Configuration Changes:** Test with inventory editor before direct file editing
4. **SSH Operations:** Use existing utility functions in `ws-utils.js`
5. **Logging:** Use structured logging via `server/logger.js`

## Security Considerations

- Never log private keys or passwords
- Validate all user inputs in API endpoints
- Use parameterized queries for any database operations
- Implement proper SSH key handling with passphrase support
- Sanitize file paths and prevent directory traversal

## Environment Setup

Required environment variables (see `.env.example`):
- `SSH_KEY_PATH` - Path to private SSH key
- `SSH_PASSPHRASE` - Key passphrase (if required)
- `SSH_PASSWORD` - Password authentication alternative
- `AI_SERVER_URL` - AI service endpoint for terminal commands
- `PORT` - Server port (default: 3000)

## Testing Strategy

- Integration tests in `tests/` directory using fetch API
- Manual testing through web interface for UI components
- SSH connectivity testing via `/api/test-ssh` endpoint
- Configuration validation testing through inventory editor

## Common Tasks

**Adding a New Service Type:**
1. Implement check function in `monitor.js`
2. Add type to validation schema
3. Update frontend action handlers if needed
4. Add test case for the new service type

**Modifying SSH Operations:**
- Update `ws-utils.js` for shared functionality
- Test with different credential types (key, password, agent)
- Verify error handling and timeout behavior
- Update documentation in KB/ folder

**UI Modifications:**
- Edit `web/app.js` for behavior changes
- Update `web/styles.css` for styling
- Test responsive behavior
- Ensure accessibility with keyboard navigation

## AI Промпты в Kosmos Panel
- Префикс команд: ai:
- Основные промпты: Terminal AI Assistant (только shell-команда), Multi-step Skill ([CMD]/[MESSAGE]/[DONE]), AI Helper (ответы на русском).
- Настройка через env: AI_SYSTEM_PROMPT, AI_MODEL и т.д.
- Подробности сохранены в памяти opencode-mem.
