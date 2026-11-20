/**
 * @file benchmark.h
 * @brief Serialized temporary-file verification and throughput measurement.
 */
#ifndef ZEPHYRFORGE_BENCHMARK_H
#define ZEPHYRFORGE_BENCHMARK_H

#include <stdbool.h>
#include <stdint.h>

#ifndef ZF_ENABLE_STORAGE_BENCHMARK
/** Optional firmware feature; enabled explicitly by the build. */
#define ZF_ENABLE_STORAGE_BENCHMARK 0
#endif

/** Maximum whole-MiB benchmark request. */
#define ZF_BENCHMARK_MAX_MIB 1024u
/** Aligned transfer size; each whole-MiB target contains complete chunks. */
#define ZF_BENCHMARK_CHUNK_SIZE 32768u

/** Retained benchmark lifecycle, encoded in Report 11. */
typedef enum {
	ZF_BENCHMARK_IDLE = 0, /**< No admitted run. */
	ZF_BENCHMARK_QUEUED = 1, /**< Storage reserved for execution. */
	ZF_BENCHMARK_PREPARING = 2, /**< Checking the mounted filesystem. */
	ZF_BENCHMARK_WRITING = 3, /**< Writing the generated pattern. */
	ZF_BENCHMARK_READING = 4, /**< Reading and verifying the pattern. */
	ZF_BENCHMARK_CLEANUP = 5, /**< Closing and removing this run's file. */
	ZF_BENCHMARK_PASSED = 6, /**< Verification and cleanup succeeded. */
	ZF_BENCHMARK_FAILED = 7, /**< Execution or cleanup failed. */
	ZF_BENCHMARK_CANCELLED = 8, /**< Cancellation and cleanup completed. */
} zf_benchmark_state_t;

/** Admission and execution details; zero means no error. */
typedef enum {
	ZF_BENCHMARK_ERROR_NONE = 0, /**< No error. */
	ZF_BENCHMARK_ERROR_BUSY = 1, /**< Another operation owns storage. */
	ZF_BENCHMARK_ERROR_USB = 2, /**< USB owns the card. */
	ZF_BENCHMARK_ERROR_SIZE = 3, /**< Size outside 1..1024 MiB. */
	ZF_BENCHMARK_ERROR_CARD = 4, /**< Medium absent or changed. */
	ZF_BENCHMARK_ERROR_SPACE = 5, /**< Insufficient filesystem space. */
	ZF_BENCHMARK_ERROR_EXISTS = 6, /**< Reserved file already exists. */
	ZF_BENCHMARK_ERROR_IO = 7, /**< Filesystem failure or short transfer. */
	ZF_BENCHMARK_ERROR_VERIFY = 8, /**< Pattern mismatch. */
	ZF_BENCHMARK_ERROR_CLEANUP = 9, /**< File close or removal failed. */
	ZF_BENCHMARK_ERROR_MOUNT = 10, /**< No firmware-owned filesystem mount. */
} zf_benchmark_error_t;

/** This run created a file that could not be removed. */
#define ZF_BENCHMARK_FILE_REMAINS 1u
/** The firmware filesystem remains mounted. */
#define ZF_BENCHMARK_MOUNTED 2u

/** Coherent progress, retained until a subsequent admitted run or reboot. */
typedef struct {
	uint8_t sequence; /**< Input publication sequence. */
	zf_benchmark_state_t state; /**< Current or terminal lifecycle. */
	uint8_t flags; /**< FILE_REMAINS and MOUNTED bits. */
	uint32_t target_bytes; /**< Requested file length. */
	uint32_t written_bytes; /**< Bytes accepted by writes. */
	uint32_t read_bytes; /**< Bytes compared with the pattern. */
	uint32_t write_elapsed_ms; /**< Pattern generation, writes and final close/sync. */
	uint32_t read_elapsed_ms; /**< Reads, verification and final close. */
	uint32_t mismatch_count; /**< Differing bytes in the first mismatching chunk. */
	zf_benchmark_error_t error; /**< Execution failure, independent of admission errors. */
	uint8_t filesystem_result; /**< FatFs result when an I/O or cleanup failure supplies one. */
} zf_benchmark_t;

/** @brief Run on the sole storage worker; only this run's exclusively created file may be removed.
 * @param size_mib Validated whole-MiB target.
 */
void zf_benchmark_run(uint32_t size_mib);

/** @brief Check media, existing path and free space without writing.
 * @param size_mib Whole-MiB target.
 * @return Benchmark error detail, or zero.
 */
int zf_platform_benchmark_preflight(uint32_t size_mib);
/** @brief Open the reserved path, exclusively creating it for writes.
 * @param writing Create for writing when true, otherwise reopen for reading.
 * @return Zero or negative errno.
 */
int zf_platform_benchmark_open(bool writing);
/** @brief Transfer one chunk without replaying short or failed I/O.
 * @param writing Write when true, otherwise read.
 * @param data Aligned chunk buffer.
 * @param size Requested byte count.
 * @param transferred Receives actual byte count.
 * @return Zero or negative errno.
 */
int zf_platform_benchmark_transfer(bool writing, uint8_t *data, uint32_t size, uint32_t *transferred);
/** @return Zero or negative errno; write close includes filesystem sync. */
int zf_platform_benchmark_close(void);
/** @return Zero or negative errno; never remove a file on replacement media. */
int zf_platform_benchmark_remove(void);
/** @return Monotonic milliseconds, modulo 2^32. */
uint32_t zf_platform_benchmark_time(void);
/** @brief Publish progress and observe media presence.
 * @param status Current run snapshot.
 * @return False requests cancellation; cleanup is still attempted.
 */
bool zf_platform_benchmark_update(const zf_benchmark_t *status);

#endif
