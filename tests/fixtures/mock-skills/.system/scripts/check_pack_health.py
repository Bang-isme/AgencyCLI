#!/usr/bin/env python3
"""Minimal pack_health stub for Agency CLI tests."""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skills-root", default="")
    parser.add_argument("--format", default="text")
    args = parser.parse_args()
    payload = {"status": "pass", "checks": []}
    if args.format == "json":
        print(json.dumps(payload))
    else:
        print("pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
