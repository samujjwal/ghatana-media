"""Fail-closed structural preflight for OOXML (ZIP) packages.

Runs before any parser sees the payload and never decompresses a member
beyond the declared limits.  Policies enforced here:

- ZIP hygiene: member names must be normalized relative paths, unique
  case-insensitively, and free of executable suffixes (fail-closed).
- Archive-bomb bounds (I6-49): member count, cumulative uncompressed
  bytes, per-member bytes, and compression ratio are hard limits.
- Nested-archive policy (I6-49): members that are themselves OOXML/ZIP
  containers — ``.zip``/``.docx``/``.docm``/``.pptx``/``.pptm``/
  ``.xlsx``/``.xlsm``/``.jar``/``.war``/``.ear`` suffixes, or parts
  declared with a ZIP/OOXML package content type in
  ``[Content_Types].xml`` — are rejected.  One archive layer only.
- External-reference prohibition (I6-50): every relationship with
  ``TargetMode="External"`` is rejected — remote images, external
  workbook links, and DDE-like links are all forbidden, and no network
  fetch ever occurs during parsing.  Relationship targets that resolve
  outside the package root are rejected as malformed.  ``externalLink``
  parts and ``ddeLink``/``ddeItems``/``oleLink`` content in XLSX are
  rejected.
- Embedded-object bounds (I6-53): ``embeddings/`` directory members and
  ``oleObject``/``activeX`` content types are rejected; anything
  remaining is still bounded by the member/byte/ratio limits.
"""
from __future__ import annotations

import io
import posixpath
import re
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from xml.etree import ElementTree

from ..errors import WorkerError

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

_EXPECTED = {
    DOCX: ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
    PPTX: ("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
    XLSX: ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
}
_MACRO_MARKERS = ("macroenabled", "vbaproject")
_EXECUTABLE_SUFFIXES = {".ade", ".adp", ".app", ".bat", ".bin", ".chm", ".cmd", ".com", ".cpl", ".dll", ".exe", ".hta", ".ins", ".isp", ".jar", ".js", ".jse", ".lib", ".lnk", ".mde", ".msc", ".msi", ".msp", ".mst", ".pif", ".ps1", ".scr", ".sct", ".shb", ".sys", ".vb", ".vbe", ".vbs", ".vxd", ".wsc", ".wsf", ".wsh"}
# ECMA-376 defines printerSettings parts as opaque binary payloads
# (e.g. ppt/printerSettings/printerSettings1.bin); the .bin suffix on this
# spec-defined path is not executable content and must not be rejected.
_SPEC_BINARY_PARTS = re.compile(r"^(word|xl|ppt)/printerSettings/printerSettings\d+\.bin$")
# I6-49: a member that is itself a ZIP/OOXML/Java container would create a
# second archive layer inside the package; one layer only.  (.jar is also
# an executable suffix; it is listed here so the nested-archive policy is
# self-describing.)
_NESTED_ARCHIVE_SUFFIXES = {".zip", ".docx", ".docm", ".pptx", ".pptm", ".xlsx", ".xlsm", ".jar", ".war", ".ear"}
# I6-49/I6-50/I6-53 (casefolded): content types that declare a whole nested
# package, an external-workbook link part, or an embedded OLE/ActiveX object.
_PACKAGE_CONTENT_TYPES = {
    "application/zip",
    "application/java-archive",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    DOCX,
    PPTX,
    XLSX,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
    "application/vnd.openxmlformats-officedocument.presentationml.template",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
}
_EMBEDDED_OBJECT_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.oleobject",
    "application/vnd.ms-office.oleobject",
    "application/vnd.openxmlformats-officedocument.activex",
    "application/vnd.openxmlformats-officedocument.activex+xml",
    "application/vnd.ms-office.activex",
    "application/vnd.ms-office.activex+xml",
}
# Opaque spec-carved part types legitimately declared without ``+xml``:
# obfuscated fonts, VML drawings, and printerSettings binaries (the same
# spec carve-out _SPEC_BINARY_PARTS honors for member names).
_OPAQUE_PART_CONTENT_TYPES = {
    "application/vnd.openxmlformats-officedocument.obfuscatedfont",
    "application/vnd.openxmlformats-officedocument.vmldrawing",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.printersettings",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.printersettings",
    "application/vnd.openxmlformats-officedocument.presentationml.printersettings",
}
# I6-50: XLSX members scanned for dynamic data-exchange content; the parts
# that legitimately carry it (xl/externalLinks/*) are already rejected by
# name and content type, so any surviving marker is hostile.
_XLSX_EXTERNAL_REF_BYTES = (b"<ddeLink", b"<ddeItems", b"<oleLink")


@dataclass(frozen=True)
class OoxmlLimits:
    max_archive_members: int
    max_uncompressed_bytes: int
    max_member_bytes: int
    max_compression_ratio: int = 100


@dataclass(frozen=True)
class OoxmlInspection:
    media_type: str
    main_part: str
    archive_members: int
    uncompressed_bytes: int


def _reject() -> None:
    raise WorkerError("INVALID_REQUEST")


def _safe_name(name: str, seen: set[str]) -> str:
    if not name or "\\" in name or name.startswith("/") or PurePosixPath(name).is_absolute():
        _reject()
    normalized = posixpath.normpath(name)
    if normalized in {".", ".."} or normalized.startswith("../") or normalized != name.rstrip("/"):
        _reject()
    key = normalized.casefold()
    if key in seen:
        _reject()
    seen.add(key)
    parts = PurePosixPath(normalized).parts
    suffix = PurePosixPath(normalized).suffix.casefold()
    if suffix in _EXECUTABLE_SUFFIXES and not _SPEC_BINARY_PARTS.match(normalized):
        _reject()
    # I6-49 nested-archive policy: a container member would open a second,
    # unbounded archive layer.
    if suffix in _NESTED_ARCHIVE_SUFFIXES:
        _reject()
    # I6-53 embedded-object policy: ``embeddings/`` parts carry OLE objects
    # (oleObject*.bin) or embedded packages; none are spec-required inputs.
    if any(part.casefold() == "embeddings" for part in parts):
        _reject()
    # I6-50: externalLink parts implement external workbook/DDE links.
    if any(part.casefold().startswith("externallink") for part in parts):
        _reject()
    return normalized


def _xml(data: bytes) -> ElementTree.Element:
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        _reject()
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError:
        _reject()
    raise AssertionError


def _is_hostile_content_type(content_type: str) -> bool:
    """Casefolded content type declares a nested package or bound object.

    OOXML *package* declarations (a whole embedded document) never carry the
    ``+xml`` suffix under the officedocument namespace — opaque spec-carved
    parts such as obfuscated fonts and VML drawings are allowlisted.  The
    same rule applies to legacy ``application/vnd.ms-*`` declarations, which
    are binary containers or OLE payloads rather than XML parts.
    """
    if content_type in _PACKAGE_CONTENT_TYPES or content_type in _EMBEDDED_OBJECT_CONTENT_TYPES:
        return True
    if "externallink" in content_type:
        return True
    for prefix in ("application/vnd.openxmlformats-officedocument.", "application/vnd.ms-"):
        if content_type.startswith(prefix) and not content_type.endswith("+xml"):
            return content_type not in _OPAQUE_PART_CONTENT_TYPES
    return False


def validate_ooxml(data: bytes, expected_media_type: str, limits: OoxmlLimits) -> OoxmlInspection:
    expected = _EXPECTED.get(expected_media_type)
    if expected is None or not isinstance(data, bytes) or any(value <= 0 for value in limits.__dict__.values()):
        _reject()
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (OSError, zipfile.BadZipFile):
        _reject()
    with archive:
        infos = archive.infolist()
        if len(infos) > limits.max_archive_members:
            raise WorkerError("LIMIT_EXCEEDED")
        seen: set[str] = set()
        names: dict[str, zipfile.ZipInfo] = {}
        total = 0
        for info in infos:
            name = _safe_name(info.filename, seen)
            if info.is_dir():
                continue
            if info.file_size > limits.max_member_bytes:
                raise WorkerError("LIMIT_EXCEEDED")
            total += info.file_size
            if total > limits.max_uncompressed_bytes:
                raise WorkerError("LIMIT_EXCEEDED")
            ratio = info.file_size / max(info.compress_size, 1)
            if ratio > limits.max_compression_ratio:
                raise WorkerError("LIMIT_EXCEEDED")
            names[name] = info
        main_part, main_content_type = expected
        if "[Content_Types].xml" not in names or main_part not in names:
            _reject()
        try:
            content_types_data = archive.read(names["[Content_Types].xml"])
        except (KeyError, OSError, RuntimeError, zipfile.BadZipFile):
            _reject()
        content_types = _xml(content_types_data)
        declared_main = False
        for node in content_types.iter():
            content_type = node.attrib.get("ContentType", "")
            lowered = content_type.strip().casefold()
            if any(marker in lowered for marker in _MACRO_MARKERS):
                _reject()
            if _is_hostile_content_type(lowered):
                _reject()
            if node.attrib.get("PartName", "").lstrip("/") == main_part and content_type == main_content_type:
                declared_main = True
        if not declared_main:
            _reject()
        for name, info in names.items():
            if expected_media_type == XLSX and name.endswith(".xml"):
                # I6-50: DDE/OLE dynamic-exchange content may only live in
                # externalLink parts, which are already rejected; a marker
                # surviving in any other XML member is hostile.
                try:
                    member_data = archive.read(info)
                except (KeyError, OSError, RuntimeError, zipfile.BadZipFile):
                    _reject()
                if any(marker in member_data for marker in _XLSX_EXTERNAL_REF_BYTES):
                    _reject()
            if name.endswith(".rels"):
                try:
                    relationships = _xml(archive.read(info))
                except (KeyError, OSError, RuntimeError, zipfile.BadZipFile):
                    _reject()
                # Relationship targets are relative to the owner part's
                # directory: ppt/_rels/presentation.xml.rels resolves against
                # ppt/, and _rels/.rels resolves against the package root.
                owner_dir = name.split("/_rels/", 1)[0] if "/_rels/" in name else ""
                for relation in relationships.iter():
                    target = relation.attrib.get("Target")
                    if not target:
                        continue
                    # I6-50 external-reference prohibition: every external
                    # relationship — remote images, external workbook links,
                    # DDE-like links — is rejected; parsing never fetches.
                    if relation.attrib.get("TargetMode", "").casefold() == "external":
                        _reject()
                    resolved = posixpath.normpath(posixpath.join(owner_dir, target.split("?", 1)[0].lstrip("/")))
                    if resolved in {"..", "."} or resolved.startswith("../"):
                        _reject()
                    resolved_suffix = PurePosixPath(resolved).suffix.casefold()
                    if resolved_suffix in _EXECUTABLE_SUFFIXES and not _SPEC_BINARY_PARTS.match(resolved):
                        _reject()
                    if resolved_suffix in _NESTED_ARCHIVE_SUFFIXES:
                        _reject()
        return OoxmlInspection(expected_media_type, main_part, len(infos), total)
