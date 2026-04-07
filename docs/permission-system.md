# Enhanced Permission System

## Overview

Buddy includes an intelligent permission system that generates smart wildcard patterns similar to Claude CLI, making the "Always Allow" functionality much more useful and user-friendly.

## Key Features

### Smart Permission Patterns

When you click "Always Allow" on a permission prompt, the bot now generates intelligent patterns that will auto-approve similar operations:

#### Bash Commands
- `git add file.txt` → `git add:*` (allows all git add operations)
- `npm install package` → `npm:*` (allows all npm operations)
- `ls directory` → `ls:*` (allows all ls operations)
- `grep pattern` → `grep:*` (allows all grep operations)

#### File Operations
- **Read operations**: `/path/to/src/file.tsx`
  - Generates: `/path/to/src/**` (allows reading all files in that directory)
  - Generates: `**/*.tsx` (allows reading all TypeScript files)

- **Edit/Write operations**: `/path/to/src/utils.js`
  - Generates: `/path/to/src/**` (allows editing all files in that directory)

#### Search Operations
- **Glob**: `**/*.ts` → `*` (allows all glob patterns)
- **Grep**: Any pattern → `*` (allows all grep searches)

### Permission Destinations

All smart suggestions are stored in the current session (`destination: "session"`), meaning they persist for the duration of your conversation but don't permanently modify your settings.

## How It Works

1. **Permission Request**: When a tool requires permission, the bot shows Allow/Deny/Always buttons
2. **Smart Generation**: If no suggestions come from Claude Agent SDK, the bot generates intelligent patterns based on the tool and input
3. **Pattern Matching**: The generated patterns use wildcards to cover similar operations
4. **Session Storage**: Approved patterns are stored for the session to auto-approve future matching operations

## Examples

### Git Workflow
```
User: @bot git status
Bot: [Permission prompt with Always Allow button]
User: [Clicks Always Allow]
Result: Future git commands auto-approved for this session

User: @bot git add .
Bot: [Auto-approved, no prompt]

User: @bot git commit -m "fix"
Bot: [Auto-approved, no prompt]
```

### File Reading Workflow
```
User: @bot Read src/components/Button.tsx
Bot: [Permission prompt with Always Allow button]
User: [Clicks Always Allow]
Result:
- All files in src/components/ directory auto-approved
- All .tsx files anywhere auto-approved

User: @bot Read src/components/Input.tsx
Bot: [Auto-approved, no prompt]

User: @bot Read tests/utils.tsx
Bot: [Auto-approved due to .tsx pattern]
```

## Configuration

The permission system behavior can be controlled through environment variables:

```env
# Permission mode (default: default)
# Options: default, bypassPermissions, dontAsk
PERMISSION_MODE=default

# Permission destination (default: projectSettings)
# Options: userSettings, projectSettings, localSettings, session, cliArg
PERMISSION_DESTINATION=projectSettings

# Preview mode for destructive operations (default: moderate)
# Options: off, moderate, destructive
PREVIEW_MODE=moderate
```

### Permission Destinations

- **projectSettings** - Project-specific permissions shared across team (default)
- **userSettings** - Permanent user-level permissions
- **localSettings** - Local workspace permissions
- **session** - Current session only
- **cliArg** - Command-line argument level

## Benefits

1. **Reduced Friction**: Fewer permission prompts for similar operations
2. **Intelligent Patterns**: Context-aware wildcard generation
3. **Configurable Storage**: Project-level permissions (default) for team-wide sharing, or session/user-level as needed
4. **User Control**: Users can still approve/deny individual operations
5. **Claude CLI Compatibility**: Similar permission patterns to what users expect

## Technical Details

- Smart suggestions are generated in `generateSmartPermissionSuggestions()`
- Patterns follow Claude Agent SDK's `PermissionUpdate` structure
- Session-scoped storage prevents permanent setting modifications
- Fallback to basic tool permissions if pattern generation fails
