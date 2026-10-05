using System.Buffers;
using System.IO.Compression;
using System.Text;

namespace Jellyfin.Plugin.Zipper.Services;

public sealed class StreamingZipWriter
{
    private const int CopyBufferSize = 128 * 1024;
    private const int FramingBufferSize = 64 * 1024;

    internal async Task WriteAsync(
        ResolvedPackage package,
        Stream responseStream,
        Action<long> serverBytesWritten,
        Action<long> payloadBytesRead,
        CancellationToken cancellationToken)
    {
        var guardedOutput = new GuardedOutputStream(responseStream, serverBytesWritten, cancellationToken);
        ZipArchive? archive = null;
        var finalized = false;
        var buffer = ArrayPool<byte>.Shared.Rent(CopyBufferSize);
        try
        {
            archive = await ZipArchive.CreateAsync(
                guardedOutput,
                ZipArchiveMode.Create,
                leaveOpen: true,
                entryNameEncoding: new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                cancellationToken).ConfigureAwait(false);

            foreach (var source in package.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ValidateArchivePath(source.ArchivePath);
                VerifySnapshot(source);

                await using var input = new FileStream(
                    source.SourcePath,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    CopyBufferSize,
                    FileOptions.Asynchronous | FileOptions.SequentialScan);

                VerifySnapshot(source);
                if (input.Length != source.Length)
                {
                    throw new IOException("A source file changed after package planning.");
                }

                var zipEntry = archive.CreateEntry(source.ArchivePath, CompressionLevel.NoCompression);
                await using (var entryStream = await zipEntry.OpenAsync(cancellationToken).ConfigureAwait(false))
                {
                    var remaining = source.Length;
                    while (remaining > 0)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        var requested = (int)Math.Min(buffer.Length, remaining);
                        var read = await input.ReadAsync(buffer.AsMemory(0, requested), cancellationToken).ConfigureAwait(false);
                        if (read == 0)
                        {
                            throw new EndOfStreamException("A source file ended before its planned length.");
                        }

                        await entryStream.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                        remaining -= read;
                        payloadBytesRead(read);
                    }

                    var extra = await input.ReadAsync(buffer.AsMemory(0, 1), cancellationToken).ConfigureAwait(false);
                    if (extra != 0)
                    {
                        throw new IOException("A source file grew after package planning.");
                    }
                }

                await guardedOutput.DrainFramingAsync(cancellationToken).ConfigureAwait(false);
                VerifySnapshot(source);
            }

            cancellationToken.ThrowIfCancellationRequested();
            guardedOutput.AllowFinalization();
            await archive.DisposeAsync().ConfigureAwait(false);
            await guardedOutput.DrainFramingAsync(cancellationToken).ConfigureAwait(false);
            finalized = true;
            await responseStream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            guardedOutput.BlockFinalization();
            if (archive is not null && !finalized)
            {
                try
                {
                    await archive.DisposeAsync().ConfigureAwait(false);
                }
                catch (Exception) when (!finalized)
                {
                    // A failed transfer must not write a valid central directory.
                }
            }

            throw;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer, clearArray: false);
        }
    }

    private static void VerifySnapshot(PackageEntry source)
    {
        try
        {
            var info = new FileInfo(source.SourcePath);
            if (!info.Exists
                || info.Length != source.Length
                || info.LastWriteTimeUtc.Ticks != source.LastWriteUtcTicks
                || (source.Kind == "companion"
                    && ((info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || info.LinkTarget is not null)))
            {
                throw new IOException("A source file changed after package planning.");
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or UnauthorizedAccessException)
        {
            throw new IOException("A source file is no longer available.");
        }
    }

    private static void ValidateArchivePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || path.Length > 1024
            || path.StartsWith('/')
            || path.StartsWith('\\')
            || Path.IsPathRooted(path)
            || path.Contains('\\')
            || path.Any(char.IsControl)
            || path.Contains(':'))
        {
            throw new InvalidDataException("A generated archive path is invalid.");
        }

        foreach (var segment in path.Split('/'))
        {
            if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith('.') || segment.EndsWith(' '))
            {
                throw new InvalidDataException("A generated archive path is invalid.");
            }
        }
    }

    private sealed class GuardedOutputStream(Stream inner, Action<long> bytesWritten, CancellationToken cancellationToken) : Stream
    {
        private bool _blockAllWrites;
        private readonly CancellationToken _cancellationToken = cancellationToken;
        // .NET's async entry disposal still writes the small data descriptor synchronously.
        // Keep that framing bounded here and drain it through async response writes.
        private readonly byte[] _framingBuffer = new byte[FramingBufferSize];
        private int _framingLength;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => !_blockAllWrites && inner.CanWrite;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public void AllowFinalization() => _cancellationToken.ThrowIfCancellationRequested();

        public void BlockFinalization() => _blockAllWrites = true;

        public override void Flush()
        {
            _cancellationToken.ThrowIfCancellationRequested();
        }

        public override async Task FlushAsync(CancellationToken cancellationToken)
        {
            await DrainFramingAsync(_cancellationToken).ConfigureAwait(false);
            await inner.FlushAsync(_cancellationToken).ConfigureAwait(false);
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
        {
            EnsureWritable();
            BufferFraming(buffer.AsSpan(offset, count));
        }

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            EnsureWritable();
            BufferFraming(buffer);
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            EnsureWritable();
            await DrainFramingAsync(_cancellationToken).ConfigureAwait(false);
            await inner.WriteAsync(buffer, _cancellationToken).ConfigureAwait(false);
            bytesWritten(buffer.Length);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        private void EnsureWritable()
        {
            _cancellationToken.ThrowIfCancellationRequested();
            if (_blockAllWrites)
            {
                throw new IOException("The package response is no longer writable.");
            }
        }

        public async Task DrainFramingAsync(CancellationToken cancellationToken)
        {
            EnsureWritable();
            if (_framingLength == 0)
            {
                return;
            }

            await inner.WriteAsync(_framingBuffer.AsMemory(0, _framingLength), cancellationToken).ConfigureAwait(false);
            bytesWritten(_framingLength);
            _framingLength = 0;
        }

        private void BufferFraming(ReadOnlySpan<byte> buffer)
        {
            if (buffer.Length > _framingBuffer.Length - _framingLength)
            {
                throw new IOException("ZIP framing exceeded the bounded response buffer.");
            }

            buffer.CopyTo(_framingBuffer.AsSpan(_framingLength));
            _framingLength += buffer.Length;
        }
    }
}
