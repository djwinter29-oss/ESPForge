#include "app/storage/storage.h"

#include <string.h>

static ef_storage_t state;
static bool raw_present;
static int64_t raw_changed_at;
static int64_t retry_at;

/** Publish before blocking media work; readers never wait for SD operations. */
static void publish(bool busy)
{
	state.busy = busy;
	state.sample_valid = state.configured && !busy && !state.msc_enabled;
	ef_storage_publish(&state);
}

static void clear_media(void)
{
	state.initialized = false;
	state.capacity_valid = false;
	state.block_count = 0;
	state.filesystem_format = 0;
}

void ef_storage_policy_init(bool configured, bool present, int64_t now_ms)
{
	memset(&state, 0, sizeof(state));
	state.configured = configured;
	state.presence_known = configured;
	state.present = present && configured;
	raw_present = state.present;
	raw_changed_at = now_ms;
	retry_at = now_ms;
	publish(false);
}

void ef_storage_policy_poll(bool present, int64_t now_ms, int request)
{
	if (!state.configured) {
		return;
	}
	if (present != raw_present) {
		raw_present = present;
		raw_changed_at = now_ms;
	}
	if (present != state.present && now_ms - raw_changed_at >= EF_STORAGE_DEBOUNCE_MS) {
		state.present = present;
		state.msc_enabled = false;
		clear_media();
		publish(true);
		(void)ef_storage_media_close();
		retry_at = now_ms;
	}
	if (request != EF_STORAGE_NO_REQUEST) {
		state.msc_transition_pending = true;
		publish(true);
		if (request == EF_STORAGE_CANCEL_REQUEST || present != state.present || !state.present) {
			state.msc_request_rejected = true;
		} else {
			state.msc_enabled = false;
			clear_media();
			publish(true);
			int err = ef_storage_media_open(request == 1, &state.block_count, &state.filesystem_format);

			if (err == 0 && request == 1) {
				err = ef_storage_usb_refresh();
			}
			state.msc_request_rejected = err != 0;
			state.initialized = err == 0;
			state.capacity_valid = state.initialized && state.block_count != 0;
			state.msc_enabled = state.initialized && request == 1;
			if (err != 0) {
				clear_media();
			}
		}
		state.msc_transition_pending = false;
		retry_at = now_ms + EF_STORAGE_RETRY_MS;
	} else if (state.present && present && !state.initialized && now_ms >= retry_at) {
		publish(true);
		int err = ef_storage_media_open(false, &state.block_count, &state.filesystem_format);

		state.initialized = err == 0;
		state.capacity_valid = state.initialized && state.block_count != 0;
		if (err != 0) {
			clear_media();
		}
		retry_at = now_ms + EF_STORAGE_RETRY_MS;
	}
	publish(false);
}
