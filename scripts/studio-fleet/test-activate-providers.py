#!/usr/bin/env python3
"""Provider activation provenance guards. Temporary artifacts only; no native commands."""
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('activate_providers', pathlib.Path(__file__).with_name('activate-providers.py'))
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


class ProviderReleaseGuards(unittest.TestCase):
    def test_prior_release_wrapper_requires_pinned_inventory_and_exact_argv(self):
        raw = json.dumps(self.manifest).encode()
        node = '/verified/node22'
        for name, command in [('codex', [node, str(self.release/'node_modules/@openai/codex/bin/codex.js')]),
                              ('claude', [str(self.release/'node_modules/@anthropic-ai/claude-code-darwin-arm64/claude')])]:
            wrapper = ('#!/bin/sh\nset -eu\nexec '+activation.shlex.join(command)+' "$@"\n').encode()
            activation.verify_prior_wrapper(name, wrapper, self.home, node, raw, activation.sha(raw))
            for altered in [wrapper+b'echo altered\n', wrapper.replace(b'"$@"', b'--different'), b'exec /unknown/native']:
                with self.assertRaises(AssertionError):
                    activation.verify_prior_wrapper(name, altered, self.home, node, raw, activation.sha(raw))
            with self.assertRaises(AssertionError):
                activation.verify_prior_wrapper(name, wrapper, self.home, node, raw, 'f'*64)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-provider-guard-')
        self.home = pathlib.Path(self.temp.name).resolve()
        self.release = self.home/'.local/share/specweave/provider-releases/synthetic-release'
        self.release.mkdir(parents=True)
        self.manifest = {'release': str(self.release), 'credentialsIncluded': False,
                         'archiveSha256': 'a'*64, 'files': []}
        for name in sorted(activation.REQUIRED_PROVIDER_FILES):
            self.add_file(name, b'synthetic-provider-version-fixture')
        link = self.release/'node_modules/.bin/codex'
        link.parent.mkdir(parents=True)
        link.symlink_to('../@openai/codex/bin/codex.js')
        self.manifest['files'].append({'path': str(link.relative_to(self.release)), 'type': 'symlink', 'target': '../@openai/codex/bin/codex.js'})
        self.before = {p: p.read_bytes() for p in self.release.rglob('*') if p.is_file() and not p.is_symlink()}

    def tearDown(self):
        self.temp.cleanup()

    def add_file(self, name, content):
        path = self.release/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        self.manifest['files'].append({'path': name, 'type': 'file', 'sha256': activation.sha(content)})

    def test_exact_pinned_manifest_and_complete_inventory_pass_without_mutation(self):
        raw = json.dumps(self.manifest).encode()
        verified = activation.decode_verified_manifest(raw, activation.sha(raw))
        self.assertEqual(activation.verify_provider_release(verified, self.home), self.release)
        self.assertEqual({p: p.read_bytes() for p in self.before}, self.before)

    def test_manifest_change_is_rejected_before_any_native_command_or_wrapper_write(self):
        raw = json.dumps(self.manifest).encode()
        altered = copy.deepcopy(self.manifest)
        altered['files'] = []
        with patch.object(activation.subprocess, 'run') as run, patch.object(activation.subprocess, 'check_output') as version, patch.object(activation, 'atomic') as atomic:
            with self.assertRaisesRegex(AssertionError, 'manifest changed'):
                activation.activate('m4', json.dumps(altered).encode(), {}, activation.sha(raw))
            run.assert_not_called(); version.assert_not_called(); atomic.assert_not_called()
        with self.assertRaisesRegex(AssertionError, 'Invalid expected'):
            activation.decode_verified_manifest(raw, 'not-a-digest')

    def test_optimized_python_cannot_disable_activation_guards(self):
        result = subprocess.run([sys.executable, '-B', '-O', str(pathlib.Path(__file__).with_name('activate-providers.py')), '--help'], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('guards require Python assertions', result.stderr)

    def test_omitted_file_extra_dependency_and_empty_directory_are_rejected(self):
        omitted = copy.deepcopy(self.manifest)
        self.add_file('node_modules/extra/package.json', b'{}')
        with self.assertRaisesRegex(AssertionError, 'extra files'):
            activation.verify_provider_release(omitted, self.home)
        self.assertEqual(activation.verify_provider_release(self.manifest, self.home), self.release)
        (self.release/'unexpected-empty-directory').mkdir()
        with self.assertRaisesRegex(AssertionError, 'extra directories'):
            activation.verify_provider_release(self.manifest, self.home)

    def test_duplicate_paths_unknown_types_and_missing_executables_are_rejected(self):
        duplicate = copy.deepcopy(self.manifest)
        duplicate['files'].append(copy.deepcopy(duplicate['files'][0]))
        with self.assertRaisesRegex(AssertionError, 'Duplicate'):
            activation.verify_provider_release(duplicate, self.home)
        unknown = copy.deepcopy(self.manifest); unknown['files'][0]['type'] = 'directory'
        with self.assertRaisesRegex(AssertionError, 'Unknown'):
            activation.verify_provider_release(unknown, self.home)
        missing = copy.deepcopy(self.manifest); missing['files'] = missing['files'][1:]
        with self.assertRaisesRegex(AssertionError, 'executable is absent'):
            activation.verify_provider_release(missing, self.home)
        empty = copy.deepcopy(self.manifest); empty['files'] = []
        with self.assertRaisesRegex(AssertionError, 'no files'):
            activation.verify_provider_release(empty, self.home)

    def test_hash_change_and_unlisted_symlinks_are_rejected(self):
        path = next(iter(self.before)); path.write_bytes(b'changed-package-content')
        with self.assertRaises(AssertionError):
            activation.verify_provider_release(self.manifest, self.home)
        path.write_bytes(self.before[path])
        (self.release/'unexpected-link').symlink_to('node_modules')
        with self.assertRaisesRegex(AssertionError, 'extra files'):
            activation.verify_provider_release(self.manifest, self.home)

    def test_traversal_noncanonical_and_external_symlink_paths_are_rejected(self):
        for value in ['../outside', '/tmp/outside', './node_modules/x', 'node_modules//x', 'node_modules/../x']:
            changed = copy.deepcopy(self.manifest); changed['files'][0]['path'] = value
            with self.subTest(path=value), self.assertRaises(AssertionError):
                activation.verify_provider_release(changed, self.home)
        link = self.release/'node_modules/.bin/codex'; link.unlink(); link.symlink_to(self.home)
        changed = copy.deepcopy(self.manifest); changed['files'][-1]['target'] = str(self.home)
        with self.assertRaisesRegex(AssertionError, 'escapes release'):
            activation.verify_provider_release(changed, self.home)


if __name__ == '__main__':
    unittest.main()
