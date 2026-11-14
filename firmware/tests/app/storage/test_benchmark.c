#include "unity.h"
#include "app/storage/benchmark.h"

#include <errno.h>
#include <string.h>

static uint8_t file[1024u * 1024u];
static uint32_t position;
static uint32_t ticks;
static bool exists;
static bool corrupt;
static bool short_transfer;
static bool cancel;
static bool close_failure;
static bool removed;
static bool remove_during_write;
static bool unlink_failure;
static bool writing;
static unsigned opens;
static unsigned deletes;
static ef_benchmark_t last;

void setUp(void)
{
	position = ticks = opens = deletes = 0;
	exists = corrupt = short_transfer = cancel = close_failure = removed = writing = false;
	remove_during_write = unlink_failure = false;
	memset(&last, 0, sizeof(last));
}

void tearDown(void) {}

int ef_platform_benchmark_preflight(uint32_t size_mib)
{
	TEST_ASSERT_EQUAL_UINT32(1, size_mib);
	return exists ? EF_BENCHMARK_ERROR_EXISTS : 0;
}

int ef_platform_benchmark_open(bool write)
{
	++opens;
	writing = write;
	position = 0;
	if (write) {
		if (exists) {
			return -EEXIST;
		}
		exists = true;
	}
	return 0;
}

int ef_platform_benchmark_transfer(bool write, uint8_t *data, uint32_t size, uint32_t *count)
{
	if (removed) {
		*count = 0;
		return -ENOMEDIUM;
	}
	*count = short_transfer ? size / 2 : size;
	TEST_ASSERT_LESS_OR_EQUAL_UINT32(sizeof(file), position + *count);
	if (write) {
		memcpy(file + position, data, *count);
	} else {
		memcpy(data, file + position, *count);
		if (corrupt) {
			data[7] ^= 0x80;
		}
	}
	position += *count;
	return 0;
}

int ef_platform_benchmark_close(void)
{
	return removed ? -ENOMEDIUM : close_failure ? -EIO : 0;
}

int ef_platform_benchmark_remove(void)
{
	++deletes;
	TEST_ASSERT_TRUE(exists);
	if (unlink_failure) {
		return -EIO;
	}
	exists = false;
	return 0;
}

uint32_t ef_platform_benchmark_time(void)
{
	ticks += 5;
	return ticks;
}

bool ef_platform_benchmark_update(const ef_benchmark_t *status)
{
	last = *status;
	if (remove_during_write && position >= EF_BENCHMARK_CHUNK_SIZE) {
		removed = true;
	}
	return !(cancel && writing && position >= EF_BENCHMARK_CHUNK_SIZE);
}

void test_benchmark_writes_verifies_and_removes_only_its_own_file(void)
{
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_PASSED, last.state);
	TEST_ASSERT_EQUAL_UINT32(sizeof(file), last.target_bytes);
	TEST_ASSERT_EQUAL_UINT32(sizeof(file), last.written_bytes);
	TEST_ASSERT_EQUAL_UINT32(sizeof(file), last.read_bytes);
	TEST_ASSERT_EQUAL_UINT32(0, last.mismatch_count);
	TEST_ASSERT_GREATER_THAN_UINT32(0, last.write_elapsed_ms);
	TEST_ASSERT_GREATER_THAN_UINT32(0, last.read_elapsed_ms);
	TEST_ASSERT_EQUAL_UINT(2, opens);
	TEST_ASSERT_EQUAL_UINT(1, deletes);
	TEST_ASSERT_FALSE(exists);
}

void test_existing_file_is_neither_opened_nor_deleted(void)
{
	exists = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_FAILED, last.state);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_ERROR_EXISTS, last.error);
	TEST_ASSERT_EQUAL_UINT(0, opens);
	TEST_ASSERT_EQUAL_UINT(0, deletes);
	TEST_ASSERT_TRUE(exists);
}

void test_short_write_is_not_replayed_and_cleanup_is_attempted(void)
{
	short_transfer = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_FAILED, last.state);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_ERROR_IO, last.error);
	TEST_ASSERT_EQUAL_UINT32(EF_BENCHMARK_CHUNK_SIZE / 2, last.written_bytes);
	TEST_ASSERT_EQUAL_UINT32(0, last.read_bytes);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	TEST_ASSERT_FALSE(exists);
}

void test_corruption_counts_differing_bytes_and_fails_verification(void)
{
	corrupt = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_FAILED, last.state);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_ERROR_VERIFY, last.error);
	TEST_ASSERT_EQUAL_UINT32(1, last.mismatch_count);
	TEST_ASSERT_EQUAL_UINT32(EF_BENCHMARK_CHUNK_SIZE, last.read_bytes);
	TEST_ASSERT_FALSE(exists);
}

void test_cancellation_retains_partial_counts_and_removes_the_created_file(void)
{
	cancel = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_CANCELLED, last.state);
	TEST_ASSERT_EQUAL_UINT32(EF_BENCHMARK_CHUNK_SIZE, last.written_bytes);
	TEST_ASSERT_EQUAL_UINT32(0, last.read_bytes);
	TEST_ASSERT_FALSE(exists);
}

void test_close_failure_does_not_unlink_a_still_open_file(void)
{
	close_failure = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_FAILED, last.state);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_ERROR_IO, last.error);
	TEST_ASSERT_EQUAL_UINT(EF_BENCHMARK_FILE_REMAINS, last.flags);
	TEST_ASSERT_EQUAL_UINT(0, deletes);
	TEST_ASSERT_TRUE(exists);
}

void test_removal_stops_io_without_reopening_or_unlinking_replacement_media(void)
{
	remove_during_write = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_FAILED, last.state);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_ERROR_CARD, last.error);
	TEST_ASSERT_EQUAL_UINT32(EF_BENCHMARK_CHUNK_SIZE, last.written_bytes);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	TEST_ASSERT_EQUAL_UINT(0, deletes);
	TEST_ASSERT_TRUE(last.flags & EF_BENCHMARK_FILE_REMAINS);
}

void test_cleanup_failure_is_not_reported_as_passed(void)
{
	unlink_failure = true;
	ef_benchmark_run(1);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_FAILED, last.state);
	TEST_ASSERT_EQUAL(EF_BENCHMARK_ERROR_CLEANUP, last.error);
	TEST_ASSERT_EQUAL_UINT32(sizeof(file), last.read_bytes);
	TEST_ASSERT_TRUE(last.flags & EF_BENCHMARK_FILE_REMAINS);
}
