Copy the provided text to the browser clipboard via Codeman's web UI. Use this when accessing Claude Code remotely through Codeman -- the text is pushed to your browser's clipboard, not the server's.

## Instructions

1. Take the input text from $ARGUMENTS
2. Use Bash to POST it to Codeman's clipboard API endpoint
3. Confirm it was copied

## Rules

- Send the text exactly as provided - no modifications
- Use curl to POST JSON to `http://localhost:3000/api/clipboard`
- Authenticate with the Codeman credentials (aakhter / P4GXAPhMDQ/lxk4+n254/Q==)
- After posting, confirm with "Pushed to browser clipboard."
- If the API returns an error, report it

## Command

```bash
curl -s -X POST http://localhost:3000/api/clipboard \
  -u 'aakhter:P4GXAPhMDQ/lxk4+n254/Q==' \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,sys; print(json.dumps({'text': sys.stdin.read()}))" <<'CLIPEOF'
$TEXT
CLIPEOF
)"
```

Where $TEXT is the input from $ARGUMENTS, properly escaped for JSON via python3.

## Input Text

$ARGUMENTS