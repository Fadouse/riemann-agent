from __future__ import annotations

import asyncio as _asyncio
import dataclasses as _dataclasses
import json as _json
import types as _types
from pathlib import Path as _Path
from typing import Any as _Any

try:
    from comm import create_comm as _create_comm
except Exception:
    _create_comm = None


_RIEMANN_MISSING = object()

class RiemannError(RuntimeError):
    def __init__(self, message: str, *, code: str = "runtime_error", details: _Any = None):
        super().__init__(message)
        self.code = code
        self.details = details


class ConflictError(RiemannError):
    pass


class ApprovalRequired(RiemannError):
    pass


class NotFoundError(RiemannError):
    pass


class AgentConflictError(ConflictError):
    pass


class AgentNotFoundError(NotFoundError):
    pass


class AgentLimitError(RiemannError):
    pass


class AgentPermissionError(RiemannError):
    pass


class AgentTimeoutError(RiemannError):
    pass


class AgentAbortedError(RiemannError):
    pass


class AgentUnavailableError(RiemannError):
    pass

@_dataclasses.dataclass(frozen=True)
class Artifact:
    handle: str
    mime_type: str
    size: int
    name: str | None = None

    async def read(self, *, offset: int = 0, limit: int | None = None):
        return await _riemann_call("artifacts.get", {"handle": self.handle, "offset": offset, "limit": limit})

    async def materialize(self, path: str):
        return await _riemann_call("artifacts.materialize", {"handle": self.handle, "path": path})

    async def view(self):
        return await _riemann_call("artifacts.view", {"handle": self.handle})


@_dataclasses.dataclass(frozen=True, repr=False)
class TextSnapshot:
    path: str
    text: str
    encoding: str
    _capability: str

    @property
    def line_count(self) -> int:
        return len(self.text.splitlines())

    def lines(self, start: int = 1, end: int | None = None) -> str:
        if start < 1:
            raise ValueError("start must be at least 1")
        lines = self.text.splitlines(keepends=True)
        return "".join(lines[start - 1 : end])

    def __repr__(self) -> str:
        return f"TextSnapshot(path={self.path!r}, chars={len(self.text)}, lines={self.line_count})"


@_dataclasses.dataclass(frozen=True, repr=False)
class ImageSnapshot:
    path: str | None
    artifact: Artifact
    mime_type: str
    source_size: int
    _capability: str | None
    width: int | None = None
    height: int | None = None

    def __repr__(self) -> str:
        dimensions = (
            f", dimensions={self.width}x{self.height}"
            if self.width is not None and self.height is not None
            else ""
        )
        return (
            f"ImageSnapshot(path={self.path!r}, mime_type={self.mime_type!r}, "
            f"source_size={self.source_size}{dimensions})"
        )


@_dataclasses.dataclass(frozen=True)
class ProcessResult:
    command: str
    exit_code: int | None
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    artifact: Artifact | None = None


@_dataclasses.dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    snippet: str
    score: float | None = None
    published_at: str | None = None


@_dataclasses.dataclass(frozen=True)
class Document:
    url: str
    title: str | None
    text: str
    content_type: str | None
    artifact: Artifact | None = None


def _agent_text_preview(value: str | None, limit: int) -> str | None:
    if not value:
        return None
    compact = " ".join(value.split())
    if not compact:
        return None
    return compact if len(compact) <= limit else f"{compact[: limit - 1]}…"


@_dataclasses.dataclass(frozen=True)
class AgentHandle:
    id: str
    name: str
    turn_id: str

    async def info(self) -> "AgentInfo":
        return await _riemann_call("agents.info", {"agent_id": self.id})

    async def wait(self, timeout: float | None = None) -> "AgentResult":
        arguments = {"agent_id": self.id, "turn_id": self.turn_id}
        if timeout is not None:
            arguments["timeout"] = timeout
        return await _riemann_call("agents.wait", arguments)

    async def send(self, message: str) -> "AgentHandle":
        return await _riemann_call(
            "agents.send",
            {"agent_id": self.id, "turn_id": self.turn_id, "message": message},
        )

    async def stop(self, timeout: float | None = None) -> "AgentResult":
        arguments = {"agent_id": self.id, "turn_id": self.turn_id}
        if timeout is not None:
            arguments["timeout"] = timeout
        return await _riemann_call("agents.stop", arguments)

    async def release(self) -> None:
        return await _riemann_call(
            "agents.release",
            {"agent_id": self.id, "turn_id": self.turn_id},
        )


@_dataclasses.dataclass(frozen=True, repr=False)
class AgentInfo(AgentHandle):
    status: str
    parent_id: str | None
    task: str
    profile: str | None
    model: str
    workspace: str
    active_turn_id: str | None
    last_turn_id: str
    last_outcome: str | None
    output_preview: str | None
    created_at: str
    updated_at: str

    def __repr__(self) -> str:
        parts = [
            f"name={self.name!r}",
            f"status={self.status!r}",
            f"task={_agent_text_preview(self.task, 80)!r}",
        ]
        if self.last_outcome is not None:
            parts.append(f"last_outcome={self.last_outcome!r}")
        if self.output_preview is not None:
            parts.append(f"output_preview={self.output_preview!r}")
        return f"AgentInfo({', '.join(parts)})"


@_dataclasses.dataclass(frozen=True, repr=False)
class AgentResult(AgentHandle):
    status: str
    outcome: str
    output: str
    error: str | None
    transcript_handle: str
    patch_handle: str | None
    started_at: str
    completed_at: str

    def __repr__(self) -> str:
        parts = [
            f"name={self.name!r}",
            f"outcome={self.outcome!r}",
            f"output={(_agent_text_preview(self.output, 160) or '')!r}",
        ]
        if self.error is not None:
            parts.append(f"error={_agent_text_preview(self.error, 160)!r}")
        return f"AgentResult({', '.join(parts)})"


class _RiemannNamespace(_types.SimpleNamespace):
    def __init__(self, name: str):
        super().__init__()
        object.__setattr__(self, "_riemann_name", name)

    def __repr__(self) -> str:
        visible = sorted(name for name in vars(self) if not name.startswith("_"))
        return f"<{self._riemann_name} namespace: {', '.join(visible) or '(empty)'}>"


_ERROR_TYPES = {
    "approval_required": ApprovalRequired,
    "conflict": AgentConflictError,
    "not_found": AgentNotFoundError,
    "limit_exceeded": AgentLimitError,
    "permission_denied": AgentPermissionError,
    "timeout": AgentTimeoutError,
    "aborted": AgentAbortedError,
    "unavailable": AgentUnavailableError,
}

_DOMAIN_TYPES = {
    "artifact": Artifact,
    "text_snapshot": TextSnapshot,
    "image_snapshot": ImageSnapshot,
    "process_result": ProcessResult,
    "search_hit": SearchHit,
    "document": Document,
    "agent_handle": AgentHandle,
    "agent_info": AgentInfo,
    "agent_result": AgentResult,
}
_RIEMANN_PROTECTED = {
    "RiemannError",
    "ConflictError",
    "ApprovalRequired",
    "NotFoundError",
    "AgentConflictError",
    "AgentNotFoundError",
    "AgentLimitError",
    "AgentPermissionError",
    "AgentTimeoutError",
    "AgentAbortedError",
    "AgentUnavailableError",
    "Artifact",
    "TextSnapshot",
    "ImageSnapshot",
    "ProcessResult",
    "SearchHit",
    "Document",
    "AgentInfo",
    "AgentResult",
    "AgentHandle",
}



def _to_wire(value):
    if isinstance(value, TextSnapshot):
        return {"$riemann": "text_snapshot_ref", "capability": value._capability}
    if isinstance(value, ImageSnapshot):
        if value._capability is None:
            raise TypeError("ImageSnapshot is not backed by a workspace file capability")
        return {"$riemann": "image_snapshot_ref", "capability": value._capability}
    if isinstance(value, Artifact):
        return {"$riemann": "artifact_ref", "handle": value.handle}
    if isinstance(value, AgentHandle):
        return {"$riemann": "agent_ref", "id": value.id, "turn_id": value.turn_id}
    if _dataclasses.is_dataclass(value):
        return {field.name: _to_wire(getattr(value, field.name)) for field in _dataclasses.fields(value)}
    if isinstance(value, _Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _to_wire(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_wire(item) for item in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    raise TypeError(f"Cannot pass {type(value).__name__} through the Riemann host bridge")


def _from_wire(value):
    if isinstance(value, list):
        return [_from_wire(item) for item in value]
    if not isinstance(value, dict):
        return value
    type_name = value.get("$riemann")
    if type_name == "function_bundle":
        specifications = value.get("specifications")
        namespace_name = value.get("namespace")
        if not isinstance(specifications, list) or not isinstance(namespace_name, str):
            raise RiemannError("Host returned an invalid function bundle", code="bridge_protocol_error")
        _install_functions(specifications)
        namespace = globals().get(namespace_name)
        if not isinstance(namespace, _RiemannNamespace):
            raise RiemannError("Host did not install the requested namespace", code="bridge_protocol_error")
        return namespace
    if isinstance(type_name, str) and type_name in _DOMAIN_TYPES:
        cls = _DOMAIN_TYPES[type_name]
        kwargs = {key: _from_wire(item) for key, item in value.items() if key != "$riemann"}
        return cls(**kwargs)
    return {key: _from_wire(item) for key, item in value.items()}


def _install_control_comm_handlers():
    kernel = getattr(get_ipython(), "kernel", None)
    manager = getattr(kernel, "comm_manager", None)
    handlers = getattr(kernel, "control_handlers", None)
    if manager is None or not isinstance(handlers, dict):
        return
    handlers.setdefault("comm_open", manager.comm_open)
    handlers.setdefault("comm_msg", manager.comm_msg)
    handlers.setdefault("comm_close", manager.comm_close)


async def _riemann_call(name: str, arguments: dict):
    if not isinstance(name, str) or not name:
        raise TypeError("function name must be a non-empty string")
    if not isinstance(arguments, dict):
        raise TypeError("function arguments must be a dict")
    if _create_comm is None:
        raise RiemannError("Jupyter Comm support is unavailable", code="bridge_unavailable")
    _install_control_comm_handlers()
    loop = _asyncio.get_running_loop()
    future = loop.create_future()
    comm = _create_comm(target_name="riemann.host", primary=False)

    def on_message(message):
        def settle():
            try:
                if future.done():
                    return
                if not isinstance(message, dict):
                    raise RiemannError("Host returned an invalid reply", code="bridge_protocol_error")
                content = message.get("content")
                if not isinstance(content, dict):
                    raise RiemannError("Host returned an invalid reply", code="bridge_protocol_error")
                reply = content.get("data")
                if not isinstance(reply, dict):
                    raise RiemannError("Host returned an invalid reply", code="bridge_protocol_error")
                status = reply.get("status")
                if status == "ok":
                    future.set_result(_from_wire(reply.get("value")))
                elif status == "error":
                    reply_error = reply.get("error")
                    if isinstance(reply_error, dict):
                        code = str(reply_error.get("code") or "runtime_error")
                        message_text = str(reply_error.get("message") or f"{name} failed")
                        error_type = _ERROR_TYPES.get(code, RiemannError)
                        future.set_exception(
                            error_type(message_text, code=code, details=reply_error.get("details"))
                        )
                    else:
                        future.set_exception(RiemannError(str(reply_error or f"{name} failed")))
                else:
                    raise RiemannError("Host returned an invalid reply status", code="bridge_protocol_error")
            except Exception as error:
                if not future.done():
                    future.set_exception(error)
            finally:
                comm.close()

        loop.call_soon_threadsafe(settle)

    comm.on_msg(on_message)
    comm.open(data={"type": name, "args": _to_wire(arguments)})
    return await future


def _make_function(namespace: _RiemannNamespace, spec: dict):
    name = spec["name"]
    qualified_name = spec["qualified_name"]
    parameters = spec.get("parameters", [])
    signature_parts = []
    for parameter in parameters:
        part = parameter["name"]
        if not parameter.get("required", False):
            part += "=_RIEMANN_MISSING"
        signature_parts.append(part)
    signature = ", ".join(signature_parts)
    source = (
        f"async def {name}({signature}):\n"
        f"    arguments = {{key: value for key, value in locals().items() if value is not _RIEMANN_MISSING}}\n"
        f"    return await _riemann_call({qualified_name!r}, arguments)"
    )
    scope = {"_riemann_call": _riemann_call, "_RIEMANN_MISSING": _RIEMANN_MISSING}
    exec(source, scope)
    function = scope[name]
    function.__module__ = "riemann"
    function.__qualname__ = qualified_name
    function.__doc__ = spec.get("description", "")
    setattr(namespace, name, function)


def _install_functions(specifications: list[dict]):
    installed = {}
    for spec in specifications:
        namespace_name = spec["namespace"]
        namespace = globals().get(namespace_name)
        if not isinstance(namespace, _RiemannNamespace):
            namespace = _RiemannNamespace(namespace_name)
            globals()[namespace_name] = namespace
        _make_function(namespace, spec)
        installed[spec["qualified_name"]] = getattr(namespace, spec["name"])
        _RIEMANN_PROTECTED.add(namespace_name)
    return installed
