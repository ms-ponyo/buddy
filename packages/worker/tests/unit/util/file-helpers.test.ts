import { extractFiles, buildFileHints } from '../../../src/util/file-helpers';

describe('extractFiles', () => {
  it('returns empty array when no files', () => {
    expect(extractFiles({})).toEqual([]);
  });

  it('extracts files from event', () => {
    const event = {
      files: [
        { id: 'F1', url_private: 'https://example.com/file1', name: 'doc.pdf', size: 2048 },
        { id: 'F2', url_private: 'https://example.com/file2', name: 'img.png', size: 4096 },
      ],
    };
    const result = extractFiles(event);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'F1', url: 'https://example.com/file1', name: 'doc.pdf', size: 2048 });
    expect(result[1]).toEqual({ id: 'F2', url: 'https://example.com/file2', name: 'img.png', size: 4096 });
  });

  it('skips files without id', () => {
    const event = {
      files: [
        { name: 'no-id.txt', size: 100 },
        { id: 'F1', name: 'has-id.txt', size: 200 },
      ],
    };
    const result = extractFiles(event);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('F1');
  });
});

describe('buildFileHints', () => {
  it('returns empty string for no files', () => {
    expect(buildFileHints([])).toBe('');
  });

  it('builds hint with size', () => {
    const files = [{ id: 'F1', url: '', name: 'doc.pdf', size: 2048 }];
    const result = buildFileHints(files);
    expect(result).toContain('doc.pdf');
    expect(result).toContain('id: F1');
    expect(result).toContain('2 KB');
    expect(result).toContain('download_slack_file');
  });

  it('omits size when zero', () => {
    const files = [{ id: 'F1', url: '', name: 'doc.pdf', size: 0 }];
    const result = buildFileHints(files);
    expect(result).not.toContain('KB');
  });

  it('joins multiple files with newlines', () => {
    const files = [
      { id: 'F1', url: '', name: 'a.txt', size: 100 },
      { id: 'F2', url: '', name: 'b.txt', size: 200 },
    ];
    const result = buildFileHints(files);
    expect(result.split('\n')).toHaveLength(2);
  });
});
