from __future__ import annotations

import asyncio as _asyncio
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
_RIEMANN_BRIDGE_ABI_VERSION = 2
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
    ):
        super().__init__(message)
        self.code = code
        self.details = details
        self.operation = operation
        self.request_id = request_id
        self.retryable = retryable


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


@_dataclasses.dataclass(frozen=True)
class Artifact:
    handle: str
    mime_type: str
    size: int
    name: str | None = None

    async def read(self, *, offset: int = 0, limit: int | None = None):
        return await _riemann_call("artifacts.get", {"handle": self.handle, "offset": offset, "limit": limit})

    async def materialize(self, *, path: str):
        return await _riemann_call("artifacts.materialize", {"handle": self.handle, "path": path})

    async def view(self):
        return await _riemann_call("artifacts.view", {"handle": self.handle})


@_dataclasses.dataclass(frozen=True, repr=False)
class TextSnapshot:
    kind: str
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


def _bounded_repr(value: str | None, limit: int) -> str:
    if value is None:
        return "None"
    bounded = value if len(value) <= limit else f"{value[: limit - 1]}…"
    return repr(bounded)


def _bounded_object_repr(value, limit: int) -> str:
    rendered = repr(value)
    return rendered if len(rendered) <= limit else f"{rendered[: limit - 1]}…"


@_dataclasses.dataclass(frozen=True, repr=False)
class ProcessResult:
    exit_code: int | None
    stdout: str
    stderr: str
    duration_ms: int
    termination: str
    stdout_truncated: bool
    stderr_truncated: bool
    artifact: Artifact | None = None

    def __repr__(self) -> str:
        return (
            f"ProcessResult(exit_code={self.exit_code!r}, termination={self.termination!r}, "
            f"stdout={_bounded_repr(self.stdout, 320)}, stderr={_bounded_repr(self.stderr, 320)}, "
            f"stdout_truncated={self.stdout_truncated!r}, stderr_truncated={self.stderr_truncated!r}, "
            f"duration_ms={self.duration_ms!r}, artifact={_bounded_object_repr(self.artifact, 240)})"
        )


@_dataclasses.dataclass(frozen=True, repr=False)
class SearchHit:
    title: str
    url: str
    snippet: str
    published_at: str | None

    def __repr__(self) -> str:
        return (
            f"SearchHit(title={_bounded_repr(self.title, 160)}, url={_bounded_repr(self.url, 240)}, "
            f"snippet={_bounded_repr(self.snippet, 320)}, "
            f"published_at={_bounded_repr(self.published_at, 120)})"
        )


@_dataclasses.dataclass(frozen=True, repr=False)
class Document:
    url: str
    title: str | None
    text: str
    content_type: str | None
    trust: str
    artifact: Artifact | None = None

    def __repr__(self) -> str:
        return (
            f"Document(url={_bounded_repr(self.url, 240)}, title={_bounded_repr(self.title, 160)}, "
            f"text={_bounded_repr(self.text, 480)}, content_type={_bounded_repr(self.content_type, 120)}, trust={self.trust!r}, "
            f"artifact={_bounded_object_repr(self.artifact, 240)})"
        )


@_dataclasses.dataclass(frozen=True)
class RemovedFile:
    path: str
    removed: bool


@_dataclasses.dataclass(frozen=True)
class McpServerStatus:
    name: str
    namespace: str
    status: str
    tool_count: int
    error: str | None


@_dataclasses.dataclass(frozen=True, repr=False)
class McpResult:
    content: list
    structured_content: _Any
    metadata: _Any
    artifacts: list[Artifact]
    extensions: dict[str, _Any]

    def __repr__(self) -> str:
        return (
            f"McpResult(content={_bounded_object_repr(self.content, 640)}, "
            f"structured_content={_bounded_object_repr(self.structured_content, 480)}, "
            f"artifacts={_bounded_object_repr(self.artifacts, 320)})"
        )


def _agent_text_preview(value: str | None, limit: int) -> str | None:
    if not value:
        return None
    compact = " ".join(value.split())
    if not compact:
        return None
    return compact if len(compact) <= limit else f"{compact[: limit - 1]}…"


@_dataclasses.dataclass(frozen=True)
class AgentTurnHandle:
    id: str
    name: str
    turn_id: str
    status: str

    async def info(self) -> "AgentInfo":
        return await _riemann_call("agents.info", {"agent_id": self.id})

    async def wait(self, *, timeout: float | None = None) -> "AgentResult":
        arguments = {"agent_id": self.id, "turn_id": self.turn_id}
        if timeout is not None:
            arguments["timeout"] = timeout
        return await _riemann_call("agents.wait", arguments)

    async def steer(self, *, message: str) -> "AgentTurnHandle":
        return await _riemann_call(
            "agents.steer",
            {"agent_id": self.id, "turn_id": self.turn_id, "message": message},
        )

    async def stop(self, *, timeout: float | None = None) -> "AgentResult":
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
class AgentInfo(AgentTurnHandle):
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
class AgentResult(AgentTurnHandle):
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

    def __setattr__(self, name: str, value):
        if not name.startswith("_"):
            raise AttributeError(f"Riemann namespace {self._riemann_name!r} is read-only")
        object.__setattr__(self, name, value)

    def __delattr__(self, name: str):
        raise AttributeError(f"Riemann namespace {self._riemann_name!r} is read-only")

    def __repr__(self) -> str:
        visible = sorted(name for name in vars(self) if not name.startswith("_"))
        return f"<{self._riemann_name} namespace: {', '.join(visible) or '(empty)'}>"


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
    "artifact.v1": Artifact,
    "text_snapshot.v1": TextSnapshot,
    "image_snapshot.v1": ImageSnapshot,
    "process_result.v1": ProcessResult,
    "search_hit.v1": SearchHit,
    "document.v1": Document,
    "removed_file.v1": RemovedFile,
    "mcp_result.v1": McpResult,
    "mcp_server_status.v1": McpServerStatus,
    "agent_turn_handle.v1": AgentTurnHandle,
    "agent_info.v1": AgentInfo,
    "agent_result.v1": AgentResult,
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


def _to_wire(value, *, _seen=None, _path="$"):
    if _seen is None:
        _seen = set()
    if isinstance(value, TextSnapshot):
        return {"$riemann": "text_snapshot_ref.v1", "capability": value._capability}
    if isinstance(value, ImageSnapshot):
        if value._capability is None:
            raise TypeError("ImageSnapshot is not backed by a file capability")
        return {"$riemann": "image_snapshot_ref.v1", "capability": value._capability}
    if isinstance(value, Artifact):
        return {"$riemann": "artifact_ref.v1", "handle": value.handle}
    if isinstance(value, AgentTurnHandle):
        return {"$riemann": "agent_turn_ref.v1", "id": value.id, "turn_id": value.turn_id}
    if isinstance(value, _Path):
        return str(value)
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if abs(value) > _RIEMANN_MAX_SAFE_INTEGER:
            raise TypeError(f"Cannot pass unsafe integer through the Riemann host bridge at {_path}: {value}")
        return value
    if isinstance(value, float):
        if not _math.isfinite(value):
            raise TypeError(f"Cannot pass non-finite float through the Riemann host bridge at {_path}: {value!r}")
        if value.is_integer() and abs(value) > _RIEMANN_MAX_SAFE_INTEGER:
            raise TypeError(f"Cannot pass unsafe integer through the Riemann host bridge at {_path}: {value!r}")
        return value
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
                        _path=_wire_path(_path, field.name),
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
                    result[key] = _to_wire(item, _seen=_seen, _path=_wire_path(_path, key))
                return result
            return [
                _to_wire(item, _seen=_seen, _path=_wire_path(_path, index))
                for index, item in enumerate(value)
            ]
        finally:
            _seen.remove(identity)
    raise TypeError(f"Cannot pass {type(value).__name__} through the Riemann host bridge at {_path}")


def _from_wire(value):
    if isinstance(value, list):
        return [_from_wire(item) for item in value]
    if not isinstance(value, dict):
        return value
    if any(not isinstance(key, str) for key in value):
        raise RiemannError("Host returned a dict with a non-string key", code="bridge_protocol_error")
    type_name = value.get("$riemann")
    if type_name == "mcp_json.v1":
        return value.get("value")
    if type_name == "function_bundle.v1":
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


async def _riemann_call(operation: str, arguments: dict):
    if not isinstance(operation, str) or not operation:
        raise TypeError("operation must be a non-empty string")
    if not isinstance(arguments, dict):
        raise TypeError("function arguments must be a dict")
    if _create_comm is None:
        raise RiemannError("Jupyter Comm support is unavailable", code="bridge_unavailable", operation=operation)
    _install_control_comm_handlers()
    encoded_arguments = _to_wire(arguments)
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
                if reply.get("abi_version") != _RIEMANN_BRIDGE_ABI_VERSION:
                    raise protocol_error("Host returned an unsupported bridge ABI version")
                if reply.get("request_id") != request_id:
                    raise protocol_error("Host returned a reply for a different request_id")
                if reply.get("operation") != operation:
                    raise protocol_error("Host returned a reply for a different operation")
                status = reply.get("status")
                common_fields = {"abi_version", "request_id", "operation", "status"}
                if status == "ok":
                    if set(reply) != common_fields | {"value"}:
                        raise protocol_error("Host returned an invalid success reply shape")
                    future.set_result(_from_wire(reply["value"]))
                elif status == "error":
                    if set(reply) != common_fields | {"error"}:
                        raise protocol_error("Host returned an invalid error reply shape")
                    reply_error = reply.get("error")
                    if not isinstance(reply_error, dict):
                        raise protocol_error("Host returned an invalid error reply")
                    allowed_error_fields = {"code", "message", "operation", "request_id", "retryable", "details"}
                    required_error_fields = allowed_error_fields - {"details"}
                    if not required_error_fields.issubset(reply_error) or set(reply_error) - allowed_error_fields:
                        raise protocol_error("Host returned an invalid error metadata shape")
                    code = reply_error.get("code")
                    message_text = reply_error.get("message")
                    error_operation = reply_error.get("operation")
                    error_request_id = reply_error.get("request_id")
                    retryable = reply_error.get("retryable")
                    if (
                        not isinstance(code, str)
                        or not code
                        or not isinstance(message_text, str)
                        or error_operation != operation
                        or error_request_id != request_id
                        or not isinstance(retryable, bool)
                    ):
                        raise protocol_error("Host returned invalid error metadata")
                    error_type = _ERROR_TYPES.get(code, RiemannError)
                    future.set_exception(
                        error_type(
                            message_text,
                            code=code,
                            details=_from_wire(reply_error.get("details")),
                            operation=operation,
                            request_id=request_id,
                            retryable=retryable,
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
    comm.open(
        data={
            "abi_version": _RIEMANN_BRIDGE_ABI_VERSION,
            "request_id": request_id,
            "operation": operation,
            "arguments": encoded_arguments,
        }
    )
    return await future


def _schema_python_type(schema: dict) -> str:
    alternatives = schema.get("anyOf") or schema.get("oneOf")
    if isinstance(alternatives, list):
        names = []
        for alternative in alternatives:
            if not isinstance(alternative, dict):
                return "Any"
            name = _schema_python_type(alternative)
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
        return f"list[{_schema_python_type(items)}]" if isinstance(items, dict) else "list"
    if schema_type == "object":
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
    if (
        not isinstance(name, str)
        or not name.isidentifier()
        or not isinstance(qualified_name, str)
        or qualified_name != f"{namespace._riemann_name}.{name}"
        or not isinstance(input_schema, dict)
        or input_schema.get("type") != "object"
        or input_schema.get("additionalProperties") is not False
        or not isinstance(input_schema.get("properties"), dict)
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
        or any(not isinstance(key, str) or not key.isidentifier() for key in properties)
        or any(not isinstance(value, dict) for value in properties.values())
    ):
        raise RiemannError("Host supplied an invalid input schema", code="bridge_protocol_error")
    required = set(required_value)
    signature_parts = []
    scope = {"_riemann_call": _riemann_call, "_RIEMANN_MISSING": _RIEMANN_MISSING}
    if properties:
        signature_parts.append("*")
    for index, (parameter_name, parameter_schema) in enumerate(properties.items()):
        part = parameter_name
        if parameter_name not in required:
            if "default" in parameter_schema:
                default_name = f"_RIEMANN_DEFAULT_{index}"
                scope[default_name] = parameter_schema["default"]
                part += f"={default_name}"
            else:
                part += "=_RIEMANN_MISSING"
        signature_parts.append(part)
    signature = ", ".join(signature_parts)
    source = (
        f"async def {name}({signature}):\n"
        f"    arguments = {{key: value for key, value in locals().items() if value is not _RIEMANN_MISSING}}\n"
        f"    return await _riemann_call({qualified_name!r}, arguments)"
    )
    exec(source, scope)
    function = scope[name]
    function.__module__ = "riemann"
    function.__qualname__ = qualified_name
    function.__annotations__ = {
        **{parameter_name: _schema_python_type(schema) for parameter_name, schema in properties.items()},
        "return": return_type,
    }
    description = spec.get("description") if isinstance(spec.get("description"), str) else ""
    argument_docs = [
        f"    {parameter_name}: {schema.get('description', 'No description provided.')}"
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
        if not isinstance(namespace_name, str) or not namespace_name.isidentifier():
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
        installed[spec["qualified_name"]] = getattr(namespace, spec["name"])
        _RIEMANN_PROTECTED.add(namespace_name)
    return installed
