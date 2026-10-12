"""Compatibility and provenance policy shared by the isolated installer/updater."""
import json
import re


def compatible_version(version):
    # 0.1.x and 0.2.x were the alpha line; 1.x.y is the stable line that follows it.
    return isinstance(version, str) and re.fullmatch(
        r'(?:0\.(?:1|2)|1\.(?:0|[1-9][0-9]*))\.(?:0|[1-9][0-9]*)', version) is not None


def validate_manifest(manifest):
    assert manifest.get('product') == 'SpecWeave Studio', 'Unexpected artifact product'
    version = manifest.get('version')
    assert compatible_version(version), 'Unsupported Studio artifact version'
    # Only the original 0.1.0 receipts may omit the richer provenance fields.
    # Every new release requires these before extraction or activation.
    if version != '0.1.0':
        assert manifest.get('schemaVersion') == 1, 'Unsupported artifact manifest schema'
        assert re.fullmatch('[a-f0-9]{40}', manifest.get('sourceCommit', '')), 'Invalid artifact source commit'
        assert re.fullmatch('[a-f0-9]{64}', manifest.get('lockSha256', '')), 'Invalid artifact lock hash'
        assert manifest.get('runtime') == 'Node22.20.0', 'Unsupported artifact runtime'
        assert manifest.get('noAuthOrUserStores') is True, 'Artifact must exclude user/auth stores'
        assert any(entry.get('path') == 'package.json' and entry.get('type') == 'file'
                   for entry in manifest.get('files', [])), 'Artifact package identity is not indexed'
    return version


def validate_package(manifest, package_bytes):
    version = validate_manifest(manifest)
    if package_bytes is None:
        assert version == '0.1.0', 'Artifact package identity is missing'
        return
    package = json.loads(package_bytes)
    assert package.get('name') == 'specweave-studio', 'Unexpected artifact package'
    assert package.get('version') == version, 'Package and artifact versions differ'


def validate_upgrade(previous, incoming):
    assert compatible_version(previous) and compatible_version(incoming), 'Unsupported update version'
    assert tuple(map(int, incoming.split('.'))) >= tuple(map(int, previous.split('.'))), 'Downgrade requires explicit rollback'
