# Multi-Select Components

## Overview

Inline multi-select checkbox components for Slack bot interactions.

## Usage

```typescript
import { createMultiSelectMessage, updateMultiSelectMessage } from './slack-handler.js';

// Define options
const options = [
  { label: 'Option 1', value: 'opt1', description: 'First choice' },
  { label: 'Option 2', value: 'opt2', description: 'Second choice' }
];

// Create initial message
const blocks = updateMultiSelectMessage('Select options:', options, []);

// Post to Slack
await client.chat.postMessage({
  channel: channelId,
  blocks: blocks
});
```

## Functions

- `createMultiSelectMessage(title, options)` - Create initial checkbox blocks
- `updateMultiSelectMessage(title, options, selections)` - Update with current state
- `handleMultiSelectToggle(selections, value)` - Toggle selection state
- `processMultiSelectSubmission(selections)` - Process final results

## Demo

Use `!multiselect-demo` command to test the interface.
