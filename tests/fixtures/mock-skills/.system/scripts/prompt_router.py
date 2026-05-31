#!/usr/bin/env python3
"""Fixture prompt_router for Agency CLI tests."""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--format", default="text")
    args = parser.parse_args()

    payload = {
        "intent": "debug",
        "suggested_agent": None,
        "workflow": "fix",
        "skills": [],
        "warnings": [],
    }
    if args.format == "json":
        print(json.dumps(payload))
    else:
        print(payload["intent"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
