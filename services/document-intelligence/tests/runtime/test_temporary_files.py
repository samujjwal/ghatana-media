from pathlib import Path

from document_intelligence.runtime.temporary_files import TemporaryFileManager


def test_temporary_files_are_random_private_and_cleaned(tmp_path: Path):
    manager = TemporaryFileManager(tmp_path / 'owned', 100)
    first = manager.write(b'abc'); second = manager.write(b'abc')
    assert first != second and first.name.startswith('worker-') and oct(first.stat().st_mode & 0o777) == '0o600'
    manager.cleanup(first); manager.cleanup_all()
    assert not first.exists() and not second.exists()
