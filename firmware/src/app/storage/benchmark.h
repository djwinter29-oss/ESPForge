/**
 * @file benchmark.h
 * @brief Serialized temporary-file verification and throughput measurement.
 */
#ifndef ESPFORGE_BENCHMARK_H
#define ESPFORGE_BENCHMARK_H

#include <stdbool.h>
#include <stdint.h>

#ifndef EF_ENABLE_STORAGE_BENCHMARK
/** Optional firmware feature; enabled explicitly by the build. */
#define EF_ENABLE_STORAGE_BENCHMARK 0
#endif

/** Maximum whole-MiB benchmark request. */
#define EF_BENCHMARK_MAX_MIB 1024u
/** Aligned transfer size; each whole-MiB target contains complete chunks. */
#define EF_BENCHMARK_CHUNK_SIZE 32768u

/** Retained benchmark lifecycle, encoded in Report 11. */
typedef enum {
	EF_BENCHMARK_IDLE = 0, /**< No admitted run. */
	EF_BENCHMARK_QUEUED = 1, /**< Storage reserved for execution. */
	EF_BENCHMARK_PREPARING = 2, /**< Checking the mounted filesystem. */
	EF_BENCHMARK_WRITING = 3, /**< Writing the generated pattern. */
	EF_BENCHMARK_READING = 4, /**< Reading and verifying the pattern. */
	EF_BENCHMARK_CLEANUP = 5, /**< Closing and removing this run's file. */
	EF_BENCHMARK_PASSED = 6, /**< Verification and cleanup succeeded. */
	EF_BENCHMARK_FAILED = 7, /**< Execution or cleanup failed. */
	EF_BENCHMARK_CANCELLED = 8, /**< Cancellation and cleanup completed. */
} ef_benchmark_state_t;

/** Admission and execution details; zero means no error. */
typedef enum {
	EF_BENCHMARK_ERROR_NONE = 0, /**< No error. */
	EF_BENCHMARK_ERROR_BUSY = 1, /**< Another operation owns storage. */
	EF_BENCHMARK_ERROR_USB = 2, /**< USB owns the card. */
	EF_BENCHMARK_ERROR_SIZE = 3, /**< Size outside 1..1024 MiB. */
	EF_BENCHMARK_ERROR_CARD = 4, /**< Medium absent or changed. */
	EF_BENCHMARK_ERROR_SPACE = 5, /**< Insufficient filesystem space. */
	EF_BENCHMARK_ERROR_EXISTS = 6, /**< Reserved file already exists. */
	EF_BENCHMARK_ERROR_IO = 7, /**< Filesystem failure or short transfer. */
	EF_BENCHMARK_ERROR_VERIFY = 8, /**< Pattern mismatch. */
	EF_BENCHMARK_ERROR_CLEANUP = 9, /**< File close or removal failed. */
	EF_BENCHMARK_ERROR_MOUNT = 10, /**< No firmware-owned filesystem mount. */
} ef_benchmark_error_t;

/** This run created a file that could not be removed. */
#define EF_BENCHMARK_FILE_REMAINS 1u
/** The firmware filesystem remains mounted. */
#define EF_BENCHMARK_MOUNTED 2u

/** Coherent progress, retained until a subsequent admitted run or reboot. */
typedef struct {
	uint8_t sequence; /**< Input publication sequence. */
	ef_benchmark_state_t state; /**< Current or terminal lifecycle. */
	uint8_t flags; /**< FILE_REMAINS and MOUNTED bits. */
	uint32_t target_bytes; /**< Requested file length. */
	uint32_t written_bytes; /**< Bytes accepted by writes. */
	uint32_t read_bytes; /**< Bytes compared with the pattern. */
	uint32_t write_elapsed_ms; /**< Pattern generation, writes and final close/sync. */
	uint32_t read_elapsed_ms; /**< Reads, verification and final close. */
	uint32_t mismatch_count; /**< Differing bytes in the first mismatching chunk. */
	ef_benchmark_error_t error; /**< Execution failure, independent of admission errors. */
	uint8_t filesystem_result; /**< FatFs result when an I/O or cleanup failure supplies one. */
} ef_benchmark_t;

/** @brief Run on the sole storage worker; only this run's exclusively created file may be removed.
 * @param size_mib Validated whole-MiB target.
 */
void ef_benchmark_run(uint32_t size_mib);

/** @brief Check media, existing path and free space without writing.
 * @param size_mib Whole-MiB target.
 * @return Benchmark error detail, or zero.
 */
int ef_platform_benchmark_preflight(uint32_t size_mib);
/** @brief Open the reserved path, exclusively creating it for writes.
 * @param writing Create for writing when true, otherwise reopen for reading.
 * @return Zero or negative errno.
 */
int ef_platform_benchmark_open(bool writing);
/** @brief Transfer one chunk without replaying short or failed I/O.
 * @param writing Write when true, otherwise read.
 * @param data Aligned chunk buffer.
 * @param size Requested byte count.
 * @param transferred Receives actual byte count.
 * @return Zero or negative errno.
 */
int ef_platform_benchmark_transfer(bool writing, uint8_t *data, uint32_t size, uint32_t *transferred);
/** @return Zero or negative errno; write close includes filesystem sync. */
int ef_platform_benchmark_close(void);
/** @return Zero or negative errno; never remove a file on replacement media. */
int ef_platform_benchmark_remove(void);
/** @return Monotonic milliseconds, modulo 2^32. */
uint32_t ef_platform_benchmark_time(void);
/** @brief Publish progress and observe media presence.
 * @param status Current run snapshot.
 * @return False requests cancellation; cleanup is still attempted.
 */
bool ef_platform_benchmark_update(const ef_benchmark_t *status);

#endif
