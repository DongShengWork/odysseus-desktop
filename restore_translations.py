#!/usr/bin/env python3
"""
Re-apply Chinese translations from git history (commit f5cc5fe) to the
current upstream code. Strategy:

1. For each previously-translated file, get the old translated version.
2. Build a mapping of (stripped_english_line → translated_line) from the
   diff between the pre-translation (efdafca) and translated (f5cc5fe) versions.
3. Walk through the current file and replace English comments/strings with
   their Chinese translations where a mapping exists.
4. Leave new/changed lines untranslated (to be translated later).
"""
import subprocess
import os
import re
import sys
from difflib import SequenceMatcher

OLD_TRANSLATED = "f5cc5fe"
PRE_TRANSLATION = "16e5723"

def git_show(ref, path):
    """Get file content at a given git ref."""
    try:
        result = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return result.stdout
    except Exception:
        pass
    return None

def get_translated_files():
    """Get list of files that were modified in the translation commits."""
    result = subprocess.run(
        ["git", "diff", "--name-only", PRE_TRANSLATION, OLD_TRANSLATED],
        capture_output=True, text=True, timeout=30
    )
    files = [f.strip() for f in result.stdout.strip().split('\n') if f.strip()]
    # Filter out non-code files and deleted files
    skip = {'.tmp_translate.py', 'ACKNOWLEDGMENTS.md', 'launch-windows.ps1',
            'update_windows.bat', 'package.json', 'package-lock.json'}
    return [f for f in files if f not in skip and os.path.exists(f)]

def build_translation_map(old_en_lines, old_zh_lines):
    """Build a mapping from English comment lines to Chinese translations.
    
    Uses sequence matching to pair up corresponding lines between the
    English and Chinese versions. Only maps lines that are comments or
    docstrings (lines where the code part is the same but comment differs).
    """
    mapping = {}
    
    # Use SequenceMatcher to find matching code blocks
    matcher = SequenceMatcher(None, old_en_lines, old_zh_lines, autojunk=False)
    
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'replace':
            # Lines changed between EN and ZH - these are translations
            # Map each old EN line to its ZH replacement
            en_block = old_en_lines[i1:i2]
            zh_block = old_zh_lines[j1:j2]
            
            if len(en_block) == len(zh_block):
                # Same number of lines - direct 1:1 mapping
                for en_line, zh_line in zip(en_block, zh_block):
                    if en_line != zh_line and en_line.strip() and zh_line.strip():
                        mapping[en_line] = zh_line
            else:
                # Different number of lines - try to match by stripped code prefix
                # For comments, the code part before the comment might be the same
                for en_line in en_block:
                    best_match = None
                    best_ratio = 0
                    en_stripped = en_line.rstrip()
                    for zh_line in zh_block:
                        zh_stripped = zh_line.rstrip()
                        if en_stripped == zh_stripped:
                            continue
                        # Check if they share the same code prefix (before comment)
                        en_code = re.split(r'#|//|/\*|\*', en_stripped, maxsplit=1)[0].strip()
                        zh_code = re.split(r'#|//|/\*|\*', zh_stripped, maxsplit=1)[0].strip()
                        if en_code and zh_code and en_code == zh_code:
                            ratio = 0.9
                        else:
                            ratio = SequenceMatcher(None, en_stripped, zh_stripped).ratio()
                        if ratio > best_ratio and ratio > 0.5:
                            best_ratio = ratio
                            best_match = zh_line
                    if best_match and en_line != best_match:
                        mapping[en_line] = best_match
        elif tag == 'insert':
            # Lines only in ZH version - could be added translated blocks
            pass
        elif tag == 'delete':
            # Lines only in EN version - removed in translation
            pass
    
    return mapping

def apply_translations(current_lines, mapping):
    """Apply the translation mapping to current file lines."""
    result = []
    applied = 0
    for line in current_lines:
        if line in mapping:
            result.append(mapping[line])
            applied += 1
        else:
            result.append(line)
    return result, applied

def process_file(filepath):
    """Process a single file: extract old translations and apply to current."""
    old_en = git_show(PRE_TRANSLATION, filepath)
    old_zh = git_show(OLD_TRANSLATED, filepath)
    
    if old_zh is None:
        return 0, "no old translated version"
    
    # Read current file
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            current_content = f.read()
    except Exception as e:
        return 0, f"read error: {e}"
    
    current_lines = current_content.splitlines(True)
    old_zh_lines = old_zh.splitlines(True)
    
    if old_en:
        old_en_lines = old_en.splitlines(True)
        mapping = build_translation_map(old_en_lines, old_zh_lines)
    else:
        # No pre-translation version - use ZH version directly as mapping source
        # Map each line to itself (for files that were entirely added)
        mapping = {}
        for line in old_zh_lines:
            mapping[line] = line  # identity - will be handled below
    
    if not mapping:
        return 0, "no translation mapping found"
    
    result, applied = apply_translations(current_lines, mapping)
    
    if applied > 0:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(result)
    
    return applied, f"applied {applied} translations"

def main():
    files = get_translated_files()
    print(f"Found {len(files)} previously translated files")
    
    total_applied = 0
    results = []
    
    for filepath in sorted(files):
        applied, msg = process_file(filepath)
        total_applied += applied
        if applied > 0:
            results.append((filepath, applied, msg))
            print(f"  ✓ {filepath}: {msg}")
        else:
            results.append((filepath, 0, msg))
    
    print(f"\nTotal: {total_applied} translations re-applied across {len(results)} files")
    
    # Summary of files with no translations applied
    no_match = [r for r in results if r[1] == 0]
    if no_match:
        print(f"\n{len(no_match)} files with no translations applied (need manual translation):")
        for f, _, msg in no_match[:20]:
            print(f"  - {f}: {msg}")

if __name__ == "__main__":
    main()
