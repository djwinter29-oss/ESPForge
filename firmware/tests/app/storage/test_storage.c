#include "unity.h"
#include "storage.h"

#include <errno.h>
#include <string.h>

static ef_storage_t published;
static int open_result;
static int close_result;
static int refresh_result;
static unsigned opens;
static unsigned closes;
static unsigned refreshes;
static bool opened_usb;

void ef_storage_publish(const ef_storage_t *storage)
{
	published = *storage;
}

int ef_storage_media_open(bool usb, uint32_t *blocks, uint8_t *format)
{
	TEST_ASSERT_TRUE(published.busy);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_FALSE(published.msc_enabled);
	++opens;
	opened_usb = usb;
	*blocks = 12345;
	*format = usb ? 0 : 3;
	return open_result;
}

int ef_storage_media_close(void)
{
	TEST_ASSERT_TRUE(published.busy);
	TEST_ASSERT_FALSE(published.msc_enabled);
	++closes;
	return close_result;
}

int ef_storage_usb_refresh(void)
{
	TEST_ASSERT_TRUE(published.msc_transition_pending);
	TEST_ASSERT_FALSE(published.msc_enabled);
	++refreshes;
	return refresh_result;
}

void setUp(void)
{
	memset(&published, 0, sizeof(published));
	open_result = close_result = refresh_result = 0;
	opens = closes = refreshes = 0;
	opened_usb = false;
	ef_storage_policy_init(true, false, 0);
}

void tearDown(void)
{
}

void test_insertion_is_debounced_then_mounted_and_removal_clears_all_card_facts(void)
{
	ef_storage_policy_poll(true, 10, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(false, 60, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(true, 100, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(true, 199, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(0, opens);
	ef_storage_policy_poll(true, 200, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_TRUE(published.present);
	TEST_ASSERT_TRUE(published.initialized);
	TEST_ASSERT_TRUE(published.capacity_valid);
	TEST_ASSERT_EQUAL_UINT8(3, published.filesystem_format);
	ef_storage_policy_poll(false, 250, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(false, 350, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.present);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
	TEST_ASSERT_EQUAL_UINT8(0, published.filesystem_format);
}

void test_boot_mount_and_failed_mount_retry_are_paced(void)
{
	ef_storage_policy_init(true, true, 0);
	open_result = -EIO;
	ef_storage_policy_poll(true, 0, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	TEST_ASSERT_TRUE(published.present);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
	ef_storage_policy_poll(true, EF_STORAGE_RETRY_MS - 1, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(1, opens);
	open_result = 0;
	ef_storage_policy_poll(true, EF_STORAGE_RETRY_MS, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_EQUAL_UINT(2, opens);
	TEST_ASSERT_TRUE(published.initialized);
}

void test_usb_export_invalidates_sd_sample_and_replacement_does_not_reexport(void)
{
	ef_storage_policy_init(true, true, 0);
	ef_storage_policy_poll(true, 0, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(true, 1, 1);
	TEST_ASSERT_TRUE(opened_usb);
	TEST_ASSERT_EQUAL_UINT(1, refreshes);
	TEST_ASSERT_TRUE(published.msc_enabled);
	TEST_ASSERT_FALSE(published.sample_valid);
	TEST_ASSERT_FALSE(published.msc_transition_pending);
	ef_storage_policy_poll(false, 10, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(false, 110, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(published.msc_enabled);
	ef_storage_policy_poll(true, 200, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(true, 300, EF_STORAGE_NO_REQUEST);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_TRUE(published.sample_valid);
}

void test_confirmed_return_remounts_and_failed_handoff_does_not_claim_a_new_owner(void)
{
	ef_storage_policy_init(true, true, 0);
	ef_storage_policy_poll(true, 0, EF_STORAGE_NO_REQUEST);
	ef_storage_policy_poll(true, 1, 1);
	ef_storage_policy_poll(true, 2, 0);
	TEST_ASSERT_FALSE(opened_usb);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_TRUE(published.initialized);
	refresh_result = -EIO;
	ef_storage_policy_poll(true, 3, 1);
	TEST_ASSERT_TRUE(published.msc_request_rejected);
	TEST_ASSERT_FALSE(published.msc_enabled);
	TEST_ASSERT_FALSE(published.initialized);
	TEST_ASSERT_EQUAL_UINT32(0, published.block_count);
}

void test_card_changed_before_an_admitted_request_cancels_it_without_media_io(void)
{
	ef_storage_policy_poll(false, 100, EF_STORAGE_CANCEL_REQUEST);
	TEST_ASSERT_EQUAL_UINT(0, opens);
	TEST_ASSERT_EQUAL_UINT(0, refreshes);
	TEST_ASSERT_TRUE(published.msc_request_rejected);
	TEST_ASSERT_FALSE(published.msc_transition_pending);
}
