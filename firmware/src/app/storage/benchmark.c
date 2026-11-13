#include "app/storage/benchmark.h"

#include <errno.h>
#include <string.h>

static uint32_t buffer[EF_BENCHMARK_CHUNK_SIZE / sizeof(uint32_t)];

static uint32_t pattern(uint32_t offset)
{
	return (offset / 4u) ^ 0xa5c391f7u;
}

static void fill(uint32_t offset)
{
	for (uint32_t i = 0; i < sizeof(buffer) / sizeof(buffer[0]); ++i) {
		buffer[i] = pattern(offset + i * 4u);
	}
}

static uint32_t mismatches(uint32_t offset)
{
	uint32_t count = 0;

	for (uint32_t i = 0; i < sizeof(buffer) / sizeof(buffer[0]); ++i) {
		for (uint32_t difference = buffer[i] ^ pattern(offset + i * 4u); difference; difference >>= 8) {
			count += (difference & 0xffu) != 0;
		}
	}
	return count;
}

static void io_error(ef_benchmark_t *status, int error)
{
	if (error != 0 && status->error == EF_BENCHMARK_ERROR_NONE) {
		status->error = error == -ENOMEDIUM ? EF_BENCHMARK_ERROR_CARD :
				error == -EEXIST ? EF_BENCHMARK_ERROR_EXISTS : EF_BENCHMARK_ERROR_IO;
	}
}

void ef_benchmark_run(uint32_t size_mib)
{
	ef_benchmark_t status = {.state = EF_BENCHMARK_PREPARING};
	bool created = false;
	bool opened = false;
	bool cancelled = false;
	bool close_failed = false;
	uint32_t start;
	int err;

	if (size_mib == 0 || size_mib > EF_BENCHMARK_MAX_MIB) {
		status.error = EF_BENCHMARK_ERROR_SIZE;
		goto cleanup;
	}
	status.target_bytes = size_mib * 1024u * 1024u;
	if (!ef_platform_benchmark_update(&status)) {
		cancelled = true;
		goto cleanup;
	}
	status.error = ef_platform_benchmark_preflight(size_mib);
	if (status.error) {
		goto cleanup;
	}
	err = ef_platform_benchmark_open(true);
	if (err != 0) {
		io_error(&status, err);
		goto cleanup;
	}
	created = opened = true;
	status.state = EF_BENCHMARK_WRITING;
	start = ef_platform_benchmark_time();
	while (status.written_bytes < status.target_bytes) {
		uint32_t count = 0;

		status.write_elapsed_ms = ef_platform_benchmark_time() - start;
		if (!ef_platform_benchmark_update(&status)) {
			cancelled = true;
			break;
		}
		fill(status.written_bytes);
		err = ef_platform_benchmark_transfer(true, (uint8_t *)buffer, sizeof(buffer), &count);
		if (count > sizeof(buffer)) {
			count = 0;
			err = -EIO;
		}
		status.written_bytes += count;
		if (err != 0 || count != sizeof(buffer)) {
			io_error(&status, err != 0 ? err : -EIO);
			break;
		}
	}
	err = ef_platform_benchmark_close();
	opened = false;
	close_failed = err != 0;
	io_error(&status, err);
	status.write_elapsed_ms = ef_platform_benchmark_time() - start;
	if (status.error || cancelled) {
		goto cleanup;
	}
	err = ef_platform_benchmark_open(false);
	if (err != 0) {
		io_error(&status, err);
		goto cleanup;
	}
	opened = true;
	status.state = EF_BENCHMARK_READING;
	start = ef_platform_benchmark_time();
	while (status.read_bytes < status.target_bytes) {
		uint32_t count = 0;

		status.read_elapsed_ms = ef_platform_benchmark_time() - start;
		if (!ef_platform_benchmark_update(&status)) {
			cancelled = true;
			break;
		}
		err = ef_platform_benchmark_transfer(false, (uint8_t *)buffer, sizeof(buffer), &count);
		if (err != 0 || count != sizeof(buffer)) {
			io_error(&status, err != 0 ? err : -EIO);
			break;
		}
		status.mismatch_count += mismatches(status.read_bytes);
		status.read_bytes += count;
		if (status.mismatch_count) {
			status.error = EF_BENCHMARK_ERROR_VERIFY;
			break;
		}
	}
	err = ef_platform_benchmark_close();
	opened = false;
	close_failed = err != 0;
	io_error(&status, err);
	status.read_elapsed_ms = ef_platform_benchmark_time() - start;

cleanup:
	status.state = EF_BENCHMARK_CLEANUP;
	(void)ef_platform_benchmark_update(&status);
	if (opened) {
		err = ef_platform_benchmark_close();
		close_failed = err != 0;
		io_error(&status, err);
	}
	if (created && (close_failed || ef_platform_benchmark_remove() != 0)) {
		status.flags |= EF_BENCHMARK_FILE_REMAINS;
		if (!status.error) {
			status.error = EF_BENCHMARK_ERROR_CLEANUP;
		}
	}
	status.state = status.error ? EF_BENCHMARK_FAILED : cancelled ? EF_BENCHMARK_CANCELLED : EF_BENCHMARK_PASSED;
	(void)ef_platform_benchmark_update(&status);
}
