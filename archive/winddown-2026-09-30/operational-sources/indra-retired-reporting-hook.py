"""Compatibility handler for sessions retaining the removed agent-reporting hook.

The reporting integration is not installed. This handler performs no reporting,
reads no session input or credentials, and lets obsolete lifecycle calls finish.
Remove it once sessions that loaded the retired hook have ended, or replace it
when deliberately reinstalling the reporting integration.
"""
import json

print(json.dumps({"systemMessage": "Agent reporting is unavailable; obsolete reporting hook skipped."}))
