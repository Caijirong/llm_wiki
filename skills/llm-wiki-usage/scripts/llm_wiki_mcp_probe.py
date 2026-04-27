#!/usr/bin/env python3
"""Minimal helper to call llm-wiki MCP over HTTP.

This script is intentionally small and transparent. It is not required for the
skill to work, but it provides a repeatable probe for initialize/tools/list/
tools/call flows when exec-based validation is useful.
"""

import argparse
import json
import sys
import urllib.request


def sse_json(raw: str):
    for line in raw.splitlines():
        if line.startswith('data: '):
            payload = line[6:].strip()
            if payload.startswith('{'):
                return json.loads(payload)
    raise RuntimeError('No JSON payload found in SSE response')


def post(url: str, headers: dict, payload: dict):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers=headers,
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.headers, resp.read().decode('utf-8', 'replace')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('--token')
    ap.add_argument('--action', choices=['initialize', 'list-tools', 'call'], required=True)
    ap.add_argument('--tool-name')
    ap.add_argument('--tool-args', default='{}')
    ap.add_argument('--session-id')
    args = ap.parse_args()

    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    }
    if args.token:
        headers['X-LLM-Wiki-Upload-Token'] = args.token
    if args.session_id:
        headers['Mcp-Session-Id'] = args.session_id

    if args.action == 'initialize':
        payload = {
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'initialize',
            'params': {
                'protocolVersion': '2024-11-05',
                'capabilities': {},
                'clientInfo': {'name': 'llm-wiki-usage', 'version': '1.0'},
            },
        }
        resp_headers, raw = post(args.url, headers, payload)
        print(json.dumps({
            'sessionId': resp_headers.get('Mcp-Session-Id'),
            'response': sse_json(raw),
        }, ensure_ascii=False, indent=2))
        return

    if not args.session_id:
        raise SystemExit('--session-id is required for this action')

    if args.action == 'list-tools':
        post(args.url, headers, {'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        _, raw = post(args.url, headers, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        print(json.dumps(sse_json(raw), ensure_ascii=False, indent=2))
        return

    if args.action == 'call':
        if not args.tool_name:
            raise SystemExit('--tool-name is required for call')
        post(args.url, headers, {'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        _, raw = post(args.url, headers, {
            'jsonrpc': '2.0',
            'id': 3,
            'method': 'tools/call',
            'params': {
                'name': args.tool_name,
                'arguments': json.loads(args.tool_args),
            },
        })
        print(json.dumps(sse_json(raw), ensure_ascii=False, indent=2))
        return


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
