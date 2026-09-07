from __future__ import annotations

import asyncio as _asyncio
import base64 as _base64
import hashlib as _hashlib
import inspect as _inspect
import itertools as _itertools
import keyword as _keyword
import dataclasses as _dataclasses
import json as _json
import math as _math
import types as _types
import uuid as _uuid
from pathlib import Path as _Path
from typing import Any as _Any

try:
    from comm import create_comm as _create_comm
except Exception:
    _create_comm = None


class _RiemannMissing:
    def __repr__(self) -> str:
        return "<omitted>"


_RIEMANN_MISSING = _RiemannMissing()
_RIEMANN_MAX_SAFE_INTEGER = (1 << 53) - 1


class RiemannError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "runtime_error",
        details: _Any = None,
        operation: str | None = None,
        request_id: str | None = None,
        retryable: bool = False,
        recovery: str = "none",
    ):
        super().__init__(message)
        self.code = code
        self.details = details
        self.operation = operation
        self.request_id = request_id
        self.retryable = retryable
        self.recovery = recovery

    def __str__(self) -> str:
        message = super().__str__()
        if isinstance(self.details, dict) and isinstance(self.details.get("errors"), list) and self.details["errors"]:
            issue = self.details["errors"][0]
            if isinstance(issue, dict) and isinstance(issue.get("expected"), str) and issue["expected"] not in message:
                message += f"; {issue.get('path') or '/'}: expected {issue['expected']}; received {issue.get('received', 'unknown')}"
        recovery = f" (recovery={self.recovery})" if self.recovery != "none" else ""
        return f"{self.operation or 'riemann'} [{self.code}]: {message}{recovery}"

    def __repr__(self) -> str:
        return _bounded_object_repr(str(self))


class ConflictError(RiemannError):
    pass


class ApprovalRequired(RiemannError):
    pass


class NotFoundError(RiemannError):
    pass


class LimitExceededError(RiemannError):
    pass


class PermissionDeniedError(RiemannError):
    pass


class RiemannTimeoutError(RiemannError):
    pass


class CancelledError(RiemannError):
    pass


class UnavailableError(RiemannError):
    pass


_RIEMANN_CONTROL_FIELDS = {"run_id", "session_id", "request_id", "contract_fingerprint", "agent_id", "parent_id", "turn_id", "active_turn_id", "last_turn_id"}

_RIEMANN_PREVIEW = {"maxPreviewBytes": 2048, "maxPreviewItems": 10, "maxPreviewDepth": 4, "maxPreviewNodes": 200}

# Presentation only: never apply these defaults to user dictionaries or output.show.
_RIEMANN_PREVIEW_DEFAULTS = {
    "Artifact": {"name": None},
    "TextSnapshot": {"kind": "text", "encoding": "utf-8"},
    "ImageSnapshot": {"kind": "image", "path": None, "width": None, "height": None},
    "ArtifactSlice": {"text": None, "base64": None},
    "Page": {"skipped": []},
    "ProcessResult": {"stdout": "", "stderr": "", "termination": "exited", "stdout_truncated": False, "stderr_truncated": False, "stdout_capture_truncated": False, "stderr_capture_truncated": False, "stdout_artifact": None, "stderr_artifact": None},
    "SearchHit": {"published_at": None, "snippet_truncated": False},
    "Document": {"title": None, "text_truncated": False, "artifact_kind": None, "artifact": None},
    "AgentInfo": {"profile": None, "last_outcome": None, "output_preview": None},
    "AgentResult": {"error": None, "transcript_handle": None, "patch_handle": None},
}
_RIEMANN_PREVIEW_HIDDEN = {
    "ProcessResult": {"duration_ms"},
    "AgentInfo": {"created_at", "updated_at", "profile", "model", "workspace", "network"},
    "AgentResult": {"started_at", "completed_at"},
    "RuntimeStatus": {"observed_at"},
}


def _preview_fields(item, depth):
    name = type(item).__name__
    defaults = _RIEMANN_PREVIEW_DEFAULTS.get(name, {})
    hidden = _RIEMANN_PREVIEW_HIDDEN.get(name, set())
    omit_empty = name in {"OperationSpec", "OperationSummary", "RuntimeStatus", "McpServerStatus", "McpResult"}
    fields = _dataclasses.fields(item)
    if isinstance(item, Page):
        order = {"coverage": 0, "next_cursor": 1, "skipped": 2, "items": 3}
        fields = sorted(fields, key=lambda field: order[field.name])
    for field in fields:
        key = field.name
        if key.startswith("_") or key in _RIEMANN_CONTROL_FIELDS or key in hidden:
            continue
        if isinstance(item, Artifact) and depth > 0 and key != "handle":
            continue
        value = getattr(item, key)
        if key in defaults and type(value) is type(defaults[key]) and value == defaults[key]:
            continue
        if omit_empty and (value is None or (type(value) in (dict, list, tuple) and not value)):
            continue
        yield key, value


def _configure_runtime(config: dict):
    if not isinstance(config, dict):
        raise TypeError("runtime configuration must be a dict")
    for key in _RIEMANN_PREVIEW:
        if key in config:
            value = config[key]
            if type(value) is not int or value < 1:
                raise ValueError(f"{key} must be a positive integer")
            _RIEMANN_PREVIEW[key] = value


def _mcp_preview_content(result, budget):
    def equal(left, right, budget, depth=0):
        budget[0] -= 1
        if budget[0] < 0 or depth > _RIEMANN_PREVIEW["maxPreviewDepth"]:
            return False
        if type(left) is not type(right):
            return type(left) in (int, float) and type(right) in (int, float) and left == right
        if type(left) is dict:
            return len(left) == len(right) and all(key in right and equal(child, right[key], budget, depth + 1) for key, child in left.items())
        if type(left) is list:
            return len(left) == len(right) and all(equal(a, b, budget, depth + 1) for a, b in zip(left, right))
        return type(left) in (str, int, float, bool, type(None)) and left == right

    content = []
    for block in result.content[:_RIEMANN_PREVIEW["maxPreviewItems"]]:
        duplicate = False
        if type(block) is dict and block.get("type") == "text" and type(block.get("text")) is str and len(block["text"]) <= _RIEMANN_PREVIEW["maxPreviewBytes"]:
            try:
                decoded = _json.loads(block["text"])
                duplicate = result.structured_content is not None and equal(decoded, result.structured_content, budget)
            except (ValueError, RecursionError):
                pass
        if not duplicate:
            content.append(block)
    if len(result.content) > _RIEMANN_PREVIEW["maxPreviewItems"]:
        content.append(f"<{len(result.content) - _RIEMANN_PREVIEW['maxPreviewItems']} content items omitted>")
    return content


def _bounded_object_repr(value, limit: int | None = None) -> str:
    budget = min(limit, _RIEMANN_PREVIEW["maxPreviewBytes"]) if limit is not None else _RIEMANN_PREVIEW["maxPreviewBytes"]
    parts = []
    remaining = max(0, budget - 3)
    nodes = 0
    seen = set()
    truncated = False

    def write(text):
        nonlocal remaining, truncated
        encoded = text[:remaining].encode("utf-8", "replace")
        prefix = encoded[:remaining].decode("utf-8", "ignore")
        parts.append(prefix)
        remaining -= len(prefix.encode("utf-8"))
        if len(prefix) < len(text):
            truncated = True

    def visit(item, depth):
        nonlocal nodes, truncated
        if remaining <= 0:
            truncated = True
            return
        nodes += 1
        if nodes > _RIEMANN_PREVIEW["maxPreviewNodes"] or depth > _RIEMANN_PREVIEW["maxPreviewDepth"]:
            write("…")
            return
        if item is None or type(item) is bool:
            write(str(item))
        elif type(item) is str:
            prefix = item[:min(remaining, max(1, _RIEMANN_PREVIEW["maxPreviewBytes"] // 4))]
            write(repr(prefix))
            if len(prefix) < len(item):
                truncated = True
        elif type(item) is int:
            write(str(item) if item.bit_length() < 256 else "<large int>")
        elif type(item) is float:
            write(repr(item))
        elif type(item) is bytes:
            write(repr(item[:min(remaining, 64)]))
            if len(item) > min(remaining, 64):
                truncated = True
        elif isinstance(item, _RiemannRecord) or type(item) in (dict, list, tuple):
            if id(item) in seen:
                write("<cycle>")
                return
            seen.add(id(item))
            try:
                is_record = isinstance(item, _RiemannRecord)
                if is_record:
                    mcp_content = None
                    if isinstance(item, McpResult):
                        budget = [_RIEMANN_PREVIEW["maxPreviewNodes"] - nodes]
                        mcp_content = _mcp_preview_content(item, budget)
                        nodes = _RIEMANN_PREVIEW["maxPreviewNodes"] - budget[0]
                    entries = ((key, f"<{item.next_offset - item.offset} bytes>" if isinstance(item, ArtifactSlice) and key == "base64" and item.kind == "binary" else mcp_content if isinstance(item, McpResult) and key == "content" else child) for key, child in _preview_fields(item, depth))
                    write(type(item).__name__ + "(")
                    closing = ")"
                elif type(item) is dict:
                    entries = iter(item.items())
                    write("{")
                    closing = "}"
                else:
                    entries = ((None, child) for child in item)
                    write("[" if type(item) is list else "(")
                    closing = "]" if type(item) is list else ")"
                for index, (key, child) in enumerate(entries):
                    if (not is_record and index >= _RIEMANN_PREVIEW["maxPreviewItems"]) or nodes >= _RIEMANN_PREVIEW["maxPreviewNodes"] or remaining <= 0:
                        write("…")
                        break
                    if index:
                        write(", ")
                    if key is not None:
                        if is_record:
                            write(key + "=")
                        else:
                            visit(key, depth + 1)
                            write(": ")
                    visit(child, depth + 1)
                write(closing)
            finally:
                seen.remove(id(item))
        else:
            # Never invoke arbitrary third-party __repr__ methods.
            write("<" + type(item).__name__ + ">")

    visit(value, 0)
    if truncated and budget >= 3:
        parts.append("…")
    return "".join(parts)


def _project_show(value, *, fields=None, _seen=None, _path=(), _sources=None):
    if _seen is None:
        _seen = set()
    if _sources is None:
        _sources = []
    if isinstance(value, _RiemannRecord) or type(value) in (dict, list, tuple):
        if id(value) in _seen:
            raise TypeError("Cannot show a cyclic value")
        _seen.add(id(value))
        try:
            if isinstance(value, Page):
                return {"$riemann": "page", "items": [_project_show(item, fields=fields, _seen=_seen, _path=(*_path, "items", str(index)), _sources=_sources) for index, item in enumerate(value.items)],
                        "next_cursor": value.next_cursor, "coverage": value.coverage,
                        "skipped": [_project_show(item, _seen=_seen, _path=(*_path, "skipped", str(index)), _sources=_sources) for index, item in enumerate(value.skipped)]}
            if type(value) in (list, tuple):
                return [_project_show(item, fields=fields, _seen=_seen, _path=(*_path, str(index)), _sources=_sources) for index, item in enumerate(value)]
            if isinstance(value, _RiemannRecord):
                available = [field.name for field in _dataclasses.fields(value) if not field.name.startswith("_")]
                names = list(fields) if fields is not None else list(available)
                if isinstance(value, ArtifactSlice):
                    available.append("data")
                    if fields is None and value.kind == "binary":
                        names = [name for name in names if name not in {"base64", "text"}] + ["data"]
                unknown = [name for name in names if name not in available]
                if unknown:
                    raise RiemannError(f"{type(value).__name__}: unknown fields {', '.join(unknown)}; available names: {', '.join(available)}", code="invalid_arguments", operation="output.show", recovery="fix_arguments")
                for name in list(names):
                    for suffix in ("_truncated", "_capture_truncated"):
                        companion = name + suffix
                        if companion in available and companion not in names and getattr(value, companion):
                            names.append(companion)
                result = {}
                for name in names:
                    child = getattr(value, name)
                    result[name] = f"<{value.next_offset - value.offset} bytes>" if isinstance(value, ArtifactSlice) and value.kind == "binary" and name in {"base64", "data"} else _project_show(child, _seen=_seen, _path=(*_path, name), _sources=_sources)
                    artifact = None
                    capture_truncated = False
                    if type(value).__name__ == "ProcessResult" and name in ("stdout", "stderr"):
                        artifact = getattr(value, name + "_artifact")
                        capture_truncated = getattr(value, name + "_capture_truncated")
                    elif type(value).__name__ == "Document" and name == "text" and value.artifact_kind == "extracted":
                        artifact = value.artifact
                    if isinstance(artifact, Artifact) and isinstance(child, str):
                        _sources.append({"path": [*_path, name], "handle": artifact.handle, "offset_bytes": len(child.encode("utf-8")), "capture_truncated": capture_truncated})
                return result
            names = fields if fields is not None else value.keys()
            unknown = [name for name in names if name not in value]
            if unknown:
                raise RiemannError(f"dict: unknown fields {', '.join(unknown)}; available names: {', '.join(str(key) for key in value)}", code="invalid_arguments", operation="output.show", recovery="fix_arguments")
            return {name: _project_show(value[name], _seen=_seen, _path=(*_path, name), _sources=_sources) for name in names}
        finally:
            _seen.remove(id(value))
    if type(value) is bytes:
        return f"<{len(value)} bytes>"
    if fields is not None:
        raise RiemannError(f"{type(value).__name__} has no fields; omit fields to display this value", code="invalid_arguments", operation="output.show", recovery="fix_arguments")
    return _to_wire(value)


def _output_view(value, *, fields=None):
    sources = []
    projected = _project_show(value, fields=fields, _sources=sources)
    return {"$riemann": "output_view", "value": projected, "sources": sources}


async def _show(*, value, fields=_RIEMANN_MISSING, _extra=None):
    arguments = {**(_extra or {}), "value": value}
    if fields is not _RIEMANN_MISSING:
        arguments["fields"] = fields
    arguments = _validate_arguments("output.show", arguments)
    return await _riemann_call("output.show", {"value": _output_view(value, fields=arguments.get("fields"))})


class _RiemannRecord:
    def __repr__(self) -> str:
        return _bounded_object_repr(self)

    def __getattr__(self, name):
        available = ", ".join(field.name for field in _dataclasses.fields(self) if not field.name.startswith("_"))
        raise AttributeError(f"{type(self).__name__} has no field {name!r}; available names: {available}")

@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class Artifact(_RiemannRecord):
    handle: str
    mime_type: str
    size: int
    name: str | None = None

    async def read(self, *, span=_RIEMANN_MISSING):
        arguments = {"handle": self.handle}
        if span is not _RIEMANN_MISSING:
            arguments["span"] = span
        return await _riemann_call("artifacts.get", arguments)

    async def materialize(self, *, path: str):
        return await _riemann_call("artifacts.materialize", {"handle": self.handle, "path": path})

    async def view(self):
        return await _riemann_call("artifacts.view", {"handle": self.handle})


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class TextSnapshot(_RiemannRecord):
    kind: str
    path: str
    text: str
    encoding: str
    _capability: str

    @property
    def line_count(self) -> int:
        return len(self.text.splitlines())

    def lines(self, *, start: int = 1, end: int | None = None) -> str:
        if type(start) is not int or start < 1 or (end is not None and (type(end) is not int or end < start)):
            raise ValueError("line range must be positive and ordered")
        return "".join(self.text.splitlines(keepends=True)[start - 1:end])


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class ImageSnapshot(_RiemannRecord):
    kind: str
    path: str | None
    artifact: Artifact
    mime_type: str
    source_size: int
    _capability: str | None
    width: int | None = None
    height: int | None = None

    async def view(self):
        return await self.artifact.view()


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class ArtifactSlice(_RiemannRecord):
    kind: str
    handle: str
    mime_type: str
    size: int
    offset: int
    next_offset: int
    eof: bool
    text: str | None = None
    base64: str | None = None

    @property
    def data(self):
        return _base64.b64decode(self.base64, validate=True) if self.kind == "binary" else self.text


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class Page(_RiemannRecord):
    items: list
    next_cursor: str | None
    coverage: str
    skipped: list

    def __iter__(self):
        return iter(self.items)

    def __len__(self):
        return len(self.items)

    def __getitem__(self, key):
        return self.items[key]

    async def next(self):
        if self.next_cursor is None:
            raise RiemannError("There is no next page", code="invalid_arguments", operation="pages.next", recovery="fix_arguments")
        return await _riemann_call("pages.next", {"cursor": self.next_cursor}, _result_contract=(self._riemann_schema, self._riemann_return_type))


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class McpResult(_RiemannRecord):
    content: list
    structured_content: _Any
    metadata: _Any
    artifacts: list[Artifact]
    extensions: dict[str, _Any]


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class AgentTurnHandle(_RiemannRecord):
    id: str
    name: str
    turn_id: str
    status: str

    async def info(self):
        return await _riemann_call("agents.info", {"agent_id": self.id})

    async def wait(self):
        arguments = {"agent_id": self.id, "turn_id": self.turn_id}
        return await _riemann_call("agents.wait", arguments)

    async def steer(self, *, message: str):
        return await _riemann_call("agents.steer", {"agent_id": self.id, "turn_id": self.turn_id, "message": message})

    async def stop(self):
        arguments = {"agent_id": self.id, "turn_id": self.turn_id}
        return await _riemann_call("agents.stop", arguments)

    async def release(self):
        return await _riemann_call("agents.release", {"agent_id": self.id, "turn_id": self.turn_id})


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class AgentInfo(AgentTurnHandle):
    parent_id: str | None
    task: str
    profile: str | None
    model: str
    workspace: str
    network: str
    active_turn_id: str | None
    last_turn_id: str
    last_outcome: str | None
    output_preview: str | None
    created_at: str
    updated_at: str


@_dataclasses.dataclass(frozen=True, repr=False, kw_only=True)
class AgentResult(AgentTurnHandle):
    outcome: str
    output: str
    error: str | None
    transcript_handle: str | None
    patch_handle: str | None
    started_at: str
    completed_at: str


class _RiemannNamespace(_types.SimpleNamespace):
    def __init__(self, name: str):
        super().__init__()
        object.__setattr__(self, "_riemann_name", name)

    def __setattr__(self, name: str, value):
        if not name.startswith("_"):
            raise AttributeError(f"Riemann namespace {self._riemann_name!r} is read-only")
        object.__setattr__(self, name, value)

    def __delattr__(self, name: str):
        raise AttributeError(f"Riemann namespace {self._riemann_name!r} is read-only")

    def __repr__(self) -> str:
        visible = []
        count = 0
        for name in vars(self):
            if not name.startswith("_"):
                count += 1
                if len(visible) < _RIEMANN_PREVIEW["maxPreviewItems"]:
                    visible.append(name)
        return _bounded_object_repr({"namespace": self._riemann_name, "operations": visible, **({"omitted_operations": count - len(visible)} if count > len(visible) else {})})


class _McpNamespace(_RiemannNamespace):
    def __init__(self, name: str, server_name: str):
        super().__init__(name)
        object.__setattr__(self, "_riemann_server_name", server_name)

    async def status(self):
        return await _riemann_call("mcp.status", {"server_name": self._riemann_server_name})

    async def refresh(self):
        return await _riemann_call("mcp.refresh", {"server_name": self._riemann_server_name})

    async def close(self):
        await _riemann_call("mcp.close", {"server_name": self._riemann_server_name})
        for existing_name in list(vars(self)):
            if not existing_name.startswith("_"):
                object.__delattr__(self, existing_name)



_ERROR_TYPES = {
    "approval_required": ApprovalRequired,
    "conflict": ConflictError,
    "not_found": NotFoundError,
    "limit_exceeded": LimitExceededError,
    "permission_denied": PermissionDeniedError,
    "timeout": RiemannTimeoutError,
    "cancelled": CancelledError,
    "unavailable": UnavailableError,
}

_DOMAIN_TYPES = {
    "artifact": Artifact,
    "artifact_slice": ArtifactSlice,
    "page": Page,
    "text_snapshot": TextSnapshot,
    "image_snapshot": ImageSnapshot,
    "process_result": "ProcessResult",
    "search_hit": "SearchHit",
    "document": "Document",
    "removed_file": "RemovedFile",
    "mcp_result": McpResult,
    "mcp_server_status": "McpServerStatus",
    "agent_turn_handle": AgentTurnHandle,
    "agent_info": AgentInfo,
    "agent_result": AgentResult,
}
_RIEMANN_PROTECTED = {
    "RiemannError",
    "ConflictError",
    "ApprovalRequired",
    "NotFoundError",
    "LimitExceededError",
    "PermissionDeniedError",
    "RiemannTimeoutError",
    "CancelledError",
    "UnavailableError",
    "Artifact",
    "ArtifactSlice",
    "Page",
    "TextSnapshot",
    "ImageSnapshot",
    "ProcessResult",
    "SearchHit",
    "Document",
    "RemovedFile",
    "McpResult",
    "McpServerStatus",
    "AgentInfo",
    "AgentResult",
    "AgentTurnHandle",
}


def _wire_path(path: str, key: str | int) -> str:
    if isinstance(key, int):
        return f"{path}[{key}]"
    return f"{path}[{key!r}]"


def _to_wire(value, *, _seen=None, _path="$", _key=_RIEMANN_MISSING):
    if _seen is None:
        _seen = set()
    if isinstance(value, TextSnapshot):
        return {"$riemann": "text_snapshot_ref", "capability": value._capability}
    if isinstance(value, ImageSnapshot):
        if value._capability is None:
            raise TypeError("ImageSnapshot is not backed by a file capability")
        return {"$riemann": "image_snapshot_ref", "capability": value._capability}
    if isinstance(value, Artifact):
        return {"$riemann": "artifact_ref", "handle": value.handle}
    if isinstance(value, AgentTurnHandle):
        return {"$riemann": "agent_turn_ref", "id": value.id, "turn_id": value.turn_id}
    if isinstance(value, _Path):
        return str(value)
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if abs(value) > _RIEMANN_MAX_SAFE_INTEGER:
            if _key is not _RIEMANN_MISSING:
                _path = _wire_path(_path, _key)
            raise TypeError(f"Cannot pass unsafe integer through the Riemann host bridge at {_path}: {value}")
        return value
    if isinstance(value, float):
        if not _math.isfinite(value):
            if _key is not _RIEMANN_MISSING:
                _path = _wire_path(_path, _key)
            raise TypeError(f"Cannot pass non-finite float through the Riemann host bridge at {_path}: {value!r}")
        if value.is_integer() and abs(value) > _RIEMANN_MAX_SAFE_INTEGER:
            if _key is not _RIEMANN_MISSING:
                _path = _wire_path(_path, _key)
            raise TypeError(f"Cannot pass unsafe integer through the Riemann host bridge at {_path}: {value!r}")
        return value
    # Primitive values need a diagnostic path only when validation fails.
    if _key is not _RIEMANN_MISSING:
        _path = _wire_path(_path, _key)
    if _dataclasses.is_dataclass(value) or isinstance(value, (dict, list, tuple)):
        identity = id(value)
        if identity in _seen:
            raise TypeError(f"Cannot pass cyclic value through the Riemann host bridge at {_path}")
        _seen.add(identity)
        try:
            if _dataclasses.is_dataclass(value):
                return {
                    field.name: _to_wire(
                        getattr(value, field.name),
                        _seen=_seen,
                        _path=_path,
                        _key=field.name,
                    )
                    for field in _dataclasses.fields(value)
                }
            if isinstance(value, dict):
                result = {}
                for key, item in value.items():
                    if not isinstance(key, str):
                        raise TypeError(
                            f"Riemann host bridge dict keys must be strings at {_path}; "
                            f"got {type(key).__name__}"
                        )
                    result[key] = _to_wire(item, _seen=_seen, _path=_path, _key=key)
                return result
            return [
                _to_wire(item, _seen=_seen, _path=_path, _key=index)
                for index, item in enumerate(value)
            ]
        finally:
            _seen.remove(identity)
    raise TypeError(f"Cannot pass {type(value).__name__} through the Riemann host bridge at {_path}")


_RIEMANN_INPUTS = {}
_RIEMANN_OUTPUTS = {}
_RIEMANN_OPERATION_CODES = {}
_RIEMANN_PENDING_OPERATIONS = {}
_RIEMANN_PENDING_NONCE = _uuid.uuid4().hex
_RIEMANN_PENDING_SEQUENCE = _itertools.count()
_RIEMANN_RECORD_SCHEMAS = {}
_RIEMANN_SCHEMA_OBJECTS = {}


def _record_name(schema, hint=None):
    tag = schema.get("properties", {}).get("$riemann", {}).get("const")
    if tag in _DOMAIN_TYPES:
        domain_type = _DOMAIN_TYPES[tag]
        return domain_type if isinstance(domain_type, str) else domain_type.__name__
    name = schema.get("$id") or hint
    if isinstance(name, str):
        if name.startswith("Page["):
            return "Page"
        if name.isidentifier() and not _keyword.iskeyword(name) and name[0].isupper():
            return name
    return None


def _child_return_type(name, key, schema, hint):
    child_hint = name + "".join(part.capitalize() for part in key.split("_"))
    if name == "Page" and key == "items" and isinstance(hint, str) and hint.startswith("Page["):
        return "list[" + hint[5:-1] + "]"
    return "list[" + child_hint + "Item]" if schema.get("type") == "array" else child_hint


def _register_result_schema(schema, hint=None):
    if not isinstance(schema, dict):
        raise RiemannError("Invalid output schema", code="bridge_protocol_error")
    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(alternatives, list):
        for branch in alternatives:
            _register_result_schema(branch, hint)
        return
    if schema.get("type") == "array":
        item_hint = hint[5:-1] if isinstance(hint, str) and hint.startswith("list[") else None
        _register_result_schema(schema.get("items", {}), item_hint)
        return
    properties = schema.get("properties")
    if schema.get("type") != "object" or not isinstance(properties, dict) or schema.get("additionalProperties") is not False:
        return
    if properties.get("$riemann", {}).get("const") == "function_bundle":
        return
    name = _record_name(schema, hint)
    if name is None:
        return
    fields = [key for key in properties if key != "$riemann"]
    if any(not key.isidentifier() or _keyword.iskeyword(key) for key in fields):
        return
    cls = globals().get(name)
    fingerprint = _hashlib.sha256(_json.dumps(schema, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if cls is not None and not (isinstance(cls, type) and issubclass(cls, _RiemannRecord)):
        raise RiemannError(f"Result type {name} conflicts with a Python global", code="bridge_protocol_error")
    if cls is None:
        required = set(schema.get("required", []))
        field_specs = [(key, _schema_python_type(properties[key], _child_return_type(name, key, properties[key], hint))) if key in required else (key, _schema_python_type(properties[key], _child_return_type(name, key, properties[key], hint)), _dataclasses.field(default=None)) for key in fields]
        cls = _dataclasses.make_dataclass(name, field_specs, bases=(_RiemannRecord,), frozen=True, repr=False, kw_only=True, namespace={"__module__": __name__})
        globals()[name] = cls
        cls._riemann_generated = True
    else:
        actual = {field.name for field in _dataclasses.fields(cls)}
        expected = set(fields)
        if cls is ArtifactSlice:
            actual -= {"text", "base64"} - expected
        if actual != expected:
            raise RiemannError(f"Output schema fields do not match {name}: {sorted(expected ^ actual)}", code="bridge_protocol_error")
        previous = _RIEMANN_RECORD_SCHEMAS.get(name)
        if getattr(cls, "_riemann_generated", False) and previous is not None and previous[0] != fingerprint:
            raise RiemannError(f"Output schema changed for {name}", code="bridge_protocol_error")
    _RIEMANN_RECORD_SCHEMAS[name] = (fingerprint, schema)
    _RIEMANN_PROTECTED.add(name)
    _RIEMANN_SCHEMA_OBJECTS[(id(schema), hint)] = schema
    for key, child in properties.items():
        if key.startswith("$"):
            continue
        _register_result_schema(child, _child_return_type(name, key, child, hint))


def _matches_schema(value, schema):
    if "const" in schema:
        return value == schema["const"] and type(value) is type(schema["const"])
    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(alternatives, list):
        return any(_matches_schema(value, branch) for branch in alternatives)
    kind = schema.get("type")
    if kind == "null":
        return value is None
    if kind == "string":
        return type(value) is str
    if kind == "boolean":
        return type(value) is bool
    if kind == "integer":
        return type(value) is int or (type(value) is float and value.is_integer())
    if kind == "number":
        return type(value) in (int, float)
    if kind == "array":
        return type(value) is list
    if kind == "object":
        if not isinstance(value, dict):
            return False
        properties = schema.get("properties", {})
        return all(key in value for key in schema.get("required", [])) and all(
            key not in value or "const" not in child or _matches_schema(value[key], child)
            for key, child in properties.items()
        )
    return True


def _from_wire(value, schema=None, return_type=None):
    if schema is None:
        # Without a declared result contract, JSON stays JSON, even with reserved-looking keys.
        return value
    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(alternatives, list):
        for branch in alternatives:
            if _matches_schema(value, branch):
                return _from_wire(value, branch, return_type)
        raise RiemannError("Result does not match any output schema branch", code="bridge_protocol_error")
    if not _matches_schema(value, schema):
        raise RiemannError("Result does not match its output schema", code="bridge_protocol_error")
    if schema.get("type") == "array":
        item_hint = return_type[5:-1] if isinstance(return_type, str) and return_type.startswith("list[") else None
        return [_from_wire(item, schema.get("items", {}), item_hint) for item in value]
    if schema.get("type") != "object" or not isinstance(value, dict):
        return value
    if any(not isinstance(key, str) for key in value):
        raise RiemannError("Host returned a dict with a non-string key", code="bridge_protocol_error")
    properties = schema.get("properties", {})
    type_name = properties.get("$riemann", {}).get("const")
    if type_name == "function_bundle":
        specifications = value.get("specifications")
        namespace_name = value.get("namespace")
        server_name = value.get("server_name")
        if (
            not isinstance(specifications, list)
            or not isinstance(namespace_name, str)
            or not isinstance(server_name, str)
        ):
            raise RiemannError("Host returned an invalid function bundle", code="bridge_protocol_error")
        existing_namespace = globals().get(namespace_name)
        if existing_namespace is not None and not isinstance(existing_namespace, _RiemannNamespace):
            raise RiemannError("MCP namespace conflicts with a protected Python global", code="bridge_protocol_error")
        if existing_namespace is None:
            existing_namespace = _McpNamespace(namespace_name, server_name)
            globals()[namespace_name] = existing_namespace
        elif not isinstance(existing_namespace, _McpNamespace) or existing_namespace._riemann_server_name != server_name:
            raise RiemannError("MCP namespace identity changed", code="bridge_protocol_error")
        if isinstance(existing_namespace, _RiemannNamespace):
            for existing_name in list(vars(existing_namespace)):
                if not existing_name.startswith("_"):
                    object.__delattr__(existing_namespace, existing_name)
        _install_functions(specifications)
        namespace = globals().get(namespace_name)
        if not isinstance(namespace, _RiemannNamespace):
            raise RiemannError("Host did not install the requested namespace", code="bridge_protocol_error")
        return namespace
    if schema.get("additionalProperties") is not False:
        return value
    if any(key not in properties for key in value):
        raise RiemannError("Unexpected result fields: " + ", ".join(key for key in value if key not in properties), code="bridge_protocol_error")
    name = _record_name(schema, return_type)
    if name is None:
        return value
    if (id(schema), return_type) not in _RIEMANN_SCHEMA_OBJECTS:
        _register_result_schema(schema, return_type)
    cls = globals()[name]
    kwargs = {}
    for key, item in value.items():
        if key == "$riemann":
            continue
        child_schema = properties.get(key, {})
        child_hint = _child_return_type(name, key, child_schema, return_type)
        if cls is McpResult and key in ("content", "structured_content", "metadata", "extensions"):
            def unwrap(raw):
                if not isinstance(raw, dict) or set(raw) != {"$riemann", "value"} or raw["$riemann"] != "mcp_json":
                    raise RiemannError("Invalid opaque MCP value", code="bridge_protocol_error")
                return raw["value"]
            kwargs[key] = [unwrap(raw) for raw in item] if key == "content" else unwrap(item)
        elif cls is McpResult and key == "artifacts":
            artifact_schema = _RIEMANN_RECORD_SCHEMAS.get("Artifact")
            kwargs[key] = [_from_wire(raw, artifact_schema[1], "Artifact") if artifact_schema else raw for raw in item]
        else:
            kwargs[key] = _from_wire(item, child_schema, child_hint)
    result = cls(**kwargs)
    if cls is Page:
        object.__setattr__(result, "_riemann_schema", schema)
        object.__setattr__(result, "_riemann_return_type", return_type)
    return result


def _install_control_comm_handlers():
    kernel = getattr(get_ipython(), "kernel", None)
    manager = getattr(kernel, "comm_manager", None)
    handlers = getattr(kernel, "control_handlers", None)
    if manager is None or not isinstance(handlers, dict):
        return
    handlers.setdefault("comm_open", manager.comm_open)
    handlers.setdefault("comm_msg", manager.comm_msg)
    handlers.setdefault("comm_close", manager.comm_close)


def _input_expectation(schema):
    bounds = {key: schema[key] for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "enum", "const") if key in schema}
    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if alternatives:
        return " | ".join(_input_expectation(branch) for branch in alternatives)
    description = schema.get("description")
    hint = " " + description[:240].replace("\n", " ") if isinstance(description, str) else ""
    return _schema_python_type(schema) + (" " + _json.dumps(bounds, ensure_ascii=False) if bounds else "") + hint


def _argument_received(value):
    if type(value) in (str, int, float, bool) or value is None:
        return f"{type(value).__name__} ({_bounded_object_repr(value, 80)})"
    return type(value).__name__


def _validate_arguments(operation, arguments):
    schema = _RIEMANN_INPUTS.get(operation)
    if schema is None:
        return arguments
    normalized = dict(arguments)
    for name, parameter in schema.get("properties", {}).items():
        if name not in normalized and "default" in parameter:
            normalized[name] = _json.loads(_json.dumps(parameter["default"]))

    def errors(value, constraint, path):
        alternatives = constraint.get("anyOf") or constraint.get("oneOf")
        if alternatives and any(not errors(value, branch, path) for branch in alternatives):
            return []
        issue = {"path": path, "received": _argument_received(value), "expected": _input_expectation(constraint), "message": "Value does not satisfy the input contract"}
        if alternatives or (constraint.get("type") != "object" and not _matches_schema(value, constraint)) or (constraint.get("type") == "object" and not isinstance(value, dict)):
            return [issue]
        if "enum" in constraint and value not in constraint["enum"]:
            return [issue]
        if type(value) in (int, float):
            if any(key in constraint and failed(value, constraint[key]) for key, failed in (("minimum", lambda a, b: a < b), ("maximum", lambda a, b: a > b), ("exclusiveMinimum", lambda a, b: a <= b), ("exclusiveMaximum", lambda a, b: a >= b))):
                return [issue]
        if type(value) in (str, list):
            lower, upper = ("minLength", "maxLength") if type(value) is str else ("minItems", "maxItems")
            if (lower in constraint and len(value) < constraint[lower]) or (upper in constraint and len(value) > constraint[upper]):
                return [issue]
        if constraint.get("type") == "object" and isinstance(value, dict):
            properties = constraint.get("properties", {})
            missing = [name for name in constraint.get("required", []) if name not in value]
            if missing:
                return [{"path": path + "/" + name, "received": "omitted", "expected": _input_expectation(properties.get(name, {})), "message": "Required argument is missing"} for name in missing[:8]]
            unknown = [name for name in value if name not in properties] if constraint.get("additionalProperties") is False else []
            if unknown:
                descriptions = [f"{name}: {_input_expectation(parameter)}" for name, parameter in properties.items() if parameter.get("description")]
                expected = "available names: " + ", ".join(properties)
                if descriptions:
                    expected += "; " + "; ".join(descriptions)[:600]
                return [{"path": path + "/" + str(name), "received": _argument_received(value[name]), "expected": expected, "message": "Unknown argument"} for name in unknown[:8]]
            issues = []
            for name, child in value.items():
                child_schema = properties.get(name, constraint.get("additionalProperties", {}))
                if isinstance(child_schema, dict):
                    issues.extend(errors(child, child_schema, path + "/" + str(name)))
                if len(issues) >= 8:
                    break
            return issues[:8]
        if constraint.get("type") == "array" and isinstance(value, list) and isinstance(constraint.get("items"), dict):
            issues = []
            for index, child in enumerate(value):
                issues.extend(errors(child, constraint["items"], path + "/" + str(index)))
                if len(issues) >= 8:
                    break
            return issues[:8]
        return []

    issues = errors(normalized, schema, "")
    if issues:
        first = issues[0]
        raise RiemannError(f"{first['path'] or '/'}: {first['message']}; expected {first['expected']}; received {first['received']}", code="invalid_arguments", operation=operation, recovery="fix_arguments", details={"errors": issues})
    return normalized


def _install_operation_formatter():
    shell = get_ipython()
    formatter = shell.display_formatter.mimebundle_formatter
    if getattr(formatter, "_riemann_operation_formatter", False):
        return
    previous = formatter.type_printers.get(_types.CoroutineType)

    def format_coroutine(value):
        entry = _RIEMANN_OPERATION_CODES.get(id(value.cr_code))
        operation = entry[1] if entry is not None and entry[0] is value.cr_code else None
        if operation is None or _inspect.getcoroutinestate(value) != _inspect.CORO_CREATED:
            return previous(value) if previous is not None else None
        # Each diagnostic retains its exact coroutine. A later cell cannot replace it;
        # the kernel nonce also prevents an old repair from resolving after a restart.
        reference = f"{_RIEMANN_PENDING_NONCE}:{next(_RIEMANN_PENDING_SEQUENCE)}"
        _RIEMANN_PENDING_OPERATIONS[reference] = value
        repair_code = f"result = await _RIEMANN_PENDING_OPERATIONS.pop({reference!r})"
        message = f"{operation} was not awaited; the operation has not started."
        return {"application/vnd.riemann.error+json": {"code": "unawaited_operation", "operation": operation, "message": message, "repair_code": repair_code}, "text/plain": message}

    formatter.for_type(_types.CoroutineType, format_coroutine)
    formatter._riemann_operation_formatter = True
    previous_exceptions = shell.custom_exceptions
    previous_handler = shell.CustomTB

    def show_error(shell, exception_type, error, traceback, tb_offset=None):
        if not isinstance(error, RiemannError):
            return previous_handler(exception_type, error, traceback, tb_offset=tb_offset)
        payload = {"code": error.code, "operation": error.operation or "riemann", "message": str(error), "retryable": error.retryable, "recovery": error.recovery}
        if error.request_id is not None:
            payload["request_id"] = error.request_id
        if error.details is not None:
            payload["details"] = error.details
        shell.display_pub.publish(data={"application/vnd.riemann.error+json": payload}, metadata={})
        short_traceback = [str(error)]
        shell._showtraceback(exception_type, error, short_traceback)
        return short_traceback

    shell.set_custom_exc((RiemannError, *previous_exceptions), show_error)


async def _riemann_call(operation: str, arguments: dict, *, _result_contract=None):
    if not isinstance(operation, str) or not operation:
        raise TypeError("operation must be a non-empty string")
    if not isinstance(arguments, dict):
        raise TypeError("function arguments must be a dict")
    if _create_comm is None:
        raise RiemannError("Jupyter Comm support is unavailable", code="bridge_unavailable", operation=operation)
    _install_control_comm_handlers()
    encoded_arguments = _to_wire(arguments)
    _validate_arguments(operation, encoded_arguments)
    loop = _asyncio.get_running_loop()
    future = loop.create_future()
    request_id = str(_uuid.uuid4())
    comm = _create_comm(target_name="riemann.host", primary=False)

    def protocol_error(message: str) -> RiemannError:
        return RiemannError(
            message,
            code="bridge_protocol_error",
            operation=operation,
            request_id=request_id,
            retryable=False,
        )

    def on_message(message):
        def settle():
            try:
                if future.done():
                    return
                if not isinstance(message, dict):
                    raise protocol_error("Host returned an invalid reply")
                content = message.get("content")
                if not isinstance(content, dict):
                    raise protocol_error("Host returned an invalid reply")
                reply = content.get("data")
                if not isinstance(reply, dict):
                    raise protocol_error("Host returned an invalid reply")
                if reply.get("request_id") != request_id:
                    raise protocol_error("Host returned a reply for a different request_id")
                if reply.get("operation") != operation:
                    raise protocol_error("Host returned a reply for a different operation")
                status = reply.get("status")
                common_fields = {"request_id", "operation", "status"}
                if status == "ok":
                    if set(reply) != common_fields | {"value"}:
                        raise protocol_error("Host returned an invalid success reply shape")
                    schema, return_type = _result_contract or _RIEMANN_OUTPUTS.get(operation, (None, None))
                    future.set_result(_from_wire(reply["value"], schema, return_type))
                elif status == "error":
                    if set(reply) != common_fields | {"error"}:
                        raise protocol_error("Host returned an invalid error reply shape")
                    reply_error = reply.get("error")
                    if not isinstance(reply_error, dict):
                        raise protocol_error("Host returned an invalid error reply")
                    allowed_error_fields = {"code", "message", "retryable", "recovery", "details"}
                    required_error_fields = allowed_error_fields - {"details"}
                    if not required_error_fields.issubset(reply_error) or set(reply_error) - allowed_error_fields:
                        raise protocol_error("Host returned an invalid error metadata shape")
                    code = reply_error.get("code")
                    message_text = reply_error.get("message")
                    recovery = reply_error.get("recovery")
                    retryable = reply_error.get("retryable")
                    if (
                        not isinstance(code, str)
                        or not code
                        or not isinstance(message_text, str)
                        or recovery not in {"none", "retry", "refresh", "fix_arguments", "reauthorize"}
                        or not isinstance(retryable, bool)
                    ):
                        raise protocol_error("Host returned invalid error metadata")
                    error_type = _ERROR_TYPES.get(code, RiemannError)
                    future.set_exception(
                        error_type(
                            message_text,
                            code=code,
                            details=reply_error.get("details"),
                            operation=operation,
                            request_id=request_id,
                            retryable=retryable,
                            recovery=recovery,
                        )
                    )
                else:
                    raise protocol_error("Host returned an invalid reply status")
            except Exception as error:
                if not future.done():
                    future.set_exception(error)
            finally:
                comm.close()

        loop.call_soon_threadsafe(settle)

    def on_close(_message):
        def settle_closed():
            if not future.done():
                future.set_exception(protocol_error("Host bridge closed before returning a reply"))
        loop.call_soon_threadsafe(settle_closed)

    comm.on_msg(on_message)
    if hasattr(comm, "on_close"):
        comm.on_close(on_close)
    try:
        comm.open(
            data={
                "request_id": request_id,
                "operation": operation,
                "arguments": encoded_arguments,
            }
        )
        return await future
    finally:
        comm.close()


def _schema_python_type(schema: dict, hint=None) -> str:
    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(alternatives, list):
        names = []
        for alternative in alternatives:
            if not isinstance(alternative, dict):
                return "Any"
            name = _schema_python_type(alternative, hint)
            if name not in names:
                names.append(name)
        return " | ".join(names) if names else "_Any"
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        names = [_schema_python_type({"type": item}) for item in schema_type]
        return " | ".join(dict.fromkeys(names))
    if schema_type == "string":
        return "str"
    if schema_type == "integer":
        return "int"
    if schema_type == "number":
        return "float"
    if schema_type == "boolean":
        return "bool"
    if schema_type == "null":
        return "None"
    if schema_type == "array":
        items = schema.get("items")
        item_hint = hint[5:-1] if isinstance(hint, str) and hint.startswith("list[") else None
        return f"list[{_schema_python_type(items, item_hint)}]" if isinstance(items, dict) else "list"
    if schema_type == "object":
        if hint is not None and schema.get("additionalProperties") is False:
            name = _record_name(schema, hint)
            if name is not None:
                return name
        additional = schema.get("additionalProperties")
        return f"dict[str, {_schema_python_type(additional)}]" if isinstance(additional, dict) else "dict"
    return "Any"


def _make_function(namespace: _RiemannNamespace, spec: dict):
    if not isinstance(spec, dict):
        raise RiemannError("Host supplied an invalid function specification", code="bridge_protocol_error")
    if "parameters" in spec or "returns" in spec:
        raise RiemannError("Host supplied a legacy function specification", code="bridge_protocol_error")
    name = spec.get("name")
    qualified_name = spec.get("qualified_name")
    input_schema = spec.get("input_schema")
    return_type = spec.get("return_type")
    output_schema = spec.get("output_schema")
    if (
        not isinstance(name, str)
        or not name.isidentifier()
        or _keyword.iskeyword(name)
        or not isinstance(qualified_name, str)
        or qualified_name != f"{namespace._riemann_name}.{name}"
        or not isinstance(input_schema, dict)
        or input_schema.get("type") != "object"
        or input_schema.get("additionalProperties") is not False
        or not isinstance(input_schema.get("properties"), dict)
        or not isinstance(output_schema, dict)
        or not isinstance(return_type, str)
        or not return_type
    ):
        raise RiemannError("Host supplied an invalid function specification", code="bridge_protocol_error")
    properties = input_schema["properties"]
    required_value = input_schema.get("required", [])
    if (
        not isinstance(required_value, list)
        or any(not isinstance(item, str) for item in required_value)
        or any(item not in properties for item in required_value)
        or any(not isinstance(key, str) or not key.isidentifier() or _keyword.iskeyword(key) for key in properties)
        or any(not isinstance(value, dict) for value in properties.values())
    ):
        raise RiemannError("Host supplied an invalid input schema", code="bridge_protocol_error")
    _register_result_schema(output_schema, return_type)
    _RIEMANN_OUTPUTS[qualified_name] = (output_schema, return_type)
    _RIEMANN_INPUTS[qualified_name] = input_schema
    if spec.get("visibility", "public") != "public":
        return
    required = set(required_value)
    signature_parts = []
    scope = {"_riemann_call": _riemann_call, "_RIEMANN_MISSING": _RIEMANN_MISSING}
    if properties:
        signature_parts.append("*")
    for index, (parameter_name, parameter_schema) in enumerate(properties.items()):
        part = parameter_name
        if parameter_name not in required:
            part += "=_RIEMANN_MISSING"
        signature_parts.append(part)
    signature = ", ".join(signature_parts)
    source = (
        f"async def {name}({signature}):\n"
        f"    arguments = {{key: value for key, value in locals().items() if value is not _RIEMANN_MISSING}}\n"
        f"    return await _riemann_call({qualified_name!r}, arguments)"
    )
    if qualified_name == "output.show":
        scope["_show"] = _show
        scope["_fields_default"] = properties["fields"].get("default", _RIEMANN_MISSING)
        source = (
            "async def show(*, value, fields=_fields_default, **_extra):\n"
            "    return await _show(value=value, fields=fields, _extra=_extra)"
        )
    exec(source, scope)
    function = scope[name]
    function.__module__ = "riemann"
    function.__qualname__ = qualified_name
    _RIEMANN_OPERATION_CODES[id(function.__code__)] = (function.__code__, qualified_name)
    function.__annotations__ = {
        **{parameter_name: _schema_python_type(schema) for parameter_name, schema in properties.items()},
        "return": return_type,
    }
    if qualified_name == "output.show":
        signature = _inspect.signature(function)
        function.__signature__ = signature.replace(parameters=[parameter for parameter in signature.parameters.values() if parameter.name != "_extra"])
    description = spec.get("description") if isinstance(spec.get("description"), str) else ""
    argument_docs = [
        f"    {parameter_name}: {_input_expectation(schema)}. {schema.get('description', 'No description provided.')}"
        for parameter_name, schema in properties.items()
    ]
    sections = [description.strip()]
    if argument_docs:
        sections.append("Keyword Args:\n" + "\n".join(argument_docs))
    sections.append(f"Returns:\n    {return_type}")
    function.__doc__ = "\n\n".join(section for section in sections if section)
    object.__setattr__(namespace, name, function)


def _install_functions(specifications: list[dict]):
    if not isinstance(specifications, list):
        raise RiemannError("Host supplied invalid function specifications", code="bridge_protocol_error")
    installed = {}
    incoming_by_namespace = {}
    for spec in specifications:
        if isinstance(spec, dict) and isinstance(spec.get("namespace"), str) and isinstance(spec.get("name"), str):
            incoming_by_namespace.setdefault(spec["namespace"], set()).add(spec["name"])
    for namespace_name, incoming_names in incoming_by_namespace.items():
        namespace = globals().get(namespace_name)
        if isinstance(namespace, _RiemannNamespace):
            for existing_name in list(vars(namespace)):
                if not existing_name.startswith("_") and existing_name not in incoming_names:
                    object.__delattr__(namespace, existing_name)
    for spec in specifications:
        if not isinstance(spec, dict):
            raise RiemannError("Host supplied an invalid function specification", code="bridge_protocol_error")
        namespace_name = spec.get("namespace")
        if not isinstance(namespace_name, str) or not namespace_name.isidentifier() or _keyword.iskeyword(namespace_name):
            raise RiemannError("Host supplied an invalid function namespace", code="bridge_protocol_error")
        namespace = globals().get(namespace_name)
        if namespace is not None and not isinstance(namespace, _RiemannNamespace):
            raise RiemannError(
                f"Function namespace {namespace_name!r} conflicts with a protected Python global",
                code="bridge_protocol_error",
            )
        if not isinstance(namespace, _RiemannNamespace):
            namespace = _RiemannNamespace(namespace_name)
            globals()[namespace_name] = namespace
        _make_function(namespace, spec)
        if spec.get("visibility", "public") == "public":
            installed[spec["qualified_name"]] = getattr(namespace, spec["name"])
        _RIEMANN_PROTECTED.add(namespace_name)
    for cls, methods in ((Artifact, {"read": "artifacts.get", "materialize": "artifacts.materialize", "view": "artifacts.view"}), (Page, {"next": "pages.next"}), (AgentTurnHandle, {name: "agents." + name for name in ("info", "wait", "steer", "stop", "release")}), (_McpNamespace, {name: "mcp." + name for name in ("status", "refresh", "close")}), (ImageSnapshot, {"view": "artifacts.view"})):
        for method_name, operation in methods.items():
            if operation not in _RIEMANN_INPUTS:
                continue
            method = getattr(cls, method_name)
            _RIEMANN_OPERATION_CODES[id(method.__code__)] = (method.__code__, operation)
            properties = _RIEMANN_INPUTS[operation].get("properties", {})
            signature = _inspect.signature(method, follow_wrapped=False)
            parameters = [parameter.replace(default=properties[parameter.name].get("default", _RIEMANN_MISSING)) if parameter.name in properties and parameter.default is not _inspect.Parameter.empty else parameter for parameter in signature.parameters.values()]
            method.__signature__ = signature.replace(parameters=parameters)
    _install_operation_formatter()
    return installed
