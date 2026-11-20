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
	state.sample_valid = state.configured && state.presence_known && !busy && !state.msc_enabled;
	ef_storage_publish(&state);
}

static void clear_media(void)
{
	state.initialized = false;
	state.capacity_valid = false;
	state.cid_valid = false;
	memset(state.cid, 0, sizeof(state.cid));
	state.block_count = 0;
	state.bus_clock_hz = 0;
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

void ef_storage_policy_poll(int present, int64_t now_ms, int request)
{
	if (!state.configured) {
		return;
	}
	if (present < 0) {
		state.presence_known = false;
		state.present = false;
		state.msc_enabled = false;
		state.msc_request_rejected |= request != EF_STORAGE_NO_REQUEST;
		clear_media();
		raw_present = false;
		raw_changed_at = now_ms;
		retry_at = now_ms;
		publish(true);
		(void)ef_storage_media_close();
		return;
	}
	present = present != 0;
	if (present != raw_present) {
		raw_present = present;
		raw_changed_at = now_ms;
		if (!present && state.present) {
			/* Even a brief observed removal invalidates the owner and the previous card's geometry. */
			state.presence_known = false;
			state.present = false;
			state.msc_enabled = false;
			clear_media();
			publish(true);
			(void)ef_storage_media_close();
			retry_at = now_ms;
		}
	}
	if (present != state.present && now_ms - raw_changed_at >= EF_STORAGE_DEBOUNCE_MS) {
		state.present = present;
		state.msc_enabled = false;
		clear_media();
		publish(true);
		(void)ef_storage_media_close();
		retry_at = now_ms;
	}
	if (now_ms - raw_changed_at >= EF_STORAGE_DEBOUNCE_MS) {
		state.presence_known = true;
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
			int err = ef_storage_media_open(request == 1, &state);

			if (err == 0 && request == 1) {
				err = ef_storage_usb_refresh();
			}
			state.msc_request_rejected = err != 0;
			state.capacity_valid = state.initialized && state.block_count != 0;
			state.msc_enabled = err == 0 && state.initialized && request == 1;
			if (err != 0 && request == 1) {
				clear_media();
				(void)ef_storage_media_close();
			} else if (!state.initialized) {
				clear_media();
			}
		}
		state.msc_transition_pending = false;
		retry_at = ef_storage_media_time() + EF_STORAGE_RETRY_MS;
	} else if (state.present && present && !state.msc_enabled &&
		   (!state.initialized || state.filesystem_format == 0) && now_ms >= retry_at) {
		publish(true);
		(void)ef_storage_media_open(false, &state);

		state.capacity_valid = state.initialized && state.block_count != 0;
		if (!state.initialized) {
			clear_media();
		}
		retry_at = ef_storage_media_time() + EF_STORAGE_RETRY_MS;
	}
	publish(false);
}
