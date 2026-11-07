#include "unity.h"
#include "wireless_auth.h"
#include "sha256.h"

#include <string.h>

static uint8_t key[EF_AUTH_KEY_SIZE];
static uint8_t nonce[EF_AUTH_NONCE_SIZE];
static uint8_t uid[EF_AUTH_UID_SIZE];
static const uint8_t reboot_request[] = {0x01, 0x07, 0x02, 0x01, 0, 0, 0, 0, 0};
static const uint8_t session_proof[] = {0x7c, 0x58, 0x3e, 0x03, 0x08, 0x7e, 0x01, 0x3d,
					0xc4, 0x44, 0xf2, 0x19, 0xfa, 0x69, 0xcf, 0xe4};
static const uint8_t command_proof[] = {0xc0, 0x90, 0xcf, 0xe4, 0xb5, 0xd6, 0x41, 0xb4,
					0xdd, 0x4f, 0x8d, 0x71, 0x0c, 0x7d, 0xad, 0x6d};
static ef_auth_session_t session;

void setUp(void)
{
	for (unsigned i = 0; i < sizeof(key); ++i) {
		key[i] = (uint8_t)i;
	}
	for (unsigned i = 0; i < sizeof(nonce); ++i) {
		nonce[i] = (uint8_t)i;
	}
	for (unsigned i = 0; i < sizeof(uid); ++i) {
		uid[i] = (uint8_t)i;
	}
	ef_auth_init(key, uid);
	ef_auth_session_reset(&session);
}

void tearDown(void)
{
}

static void unlock(void)
{
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(0, ef_auth_write_proof(&session, session_proof, 16, 0));
	TEST_ASSERT_TRUE(session.unlocked);
}

void test_worked_vector_proofs(void)
{
	uint8_t proof[EF_AUTH_PROOF_SIZE];

	ef_auth_proof(key, nonce, uid, (const uint8_t *)"SESSION01", 9, proof);
	TEST_ASSERT_EQUAL_UINT8_ARRAY(session_proof, proof, 16);
	ef_auth_proof(key, nonce, uid, reboot_request, sizeof(reboot_request), proof);
	TEST_ASSERT_EQUAL_UINT8_ARRAY(command_proof, proof, 16);
}

void test_session_unlock_then_command_proof_is_one_use(void)
{
	unlock();
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(0, ef_auth_write_proof(&session, command_proof, 16, 10));
	TEST_ASSERT_EQUAL_UINT8(0, ef_auth_authorize(&session, reboot_request, sizeof(reboot_request), 10));
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_UNAVAILABLE,
				ef_auth_authorize(&session, reboot_request, sizeof(reboot_request), 11));
}

void test_proof_write_checks_length_delay_and_challenge_in_order(void)
{
	uint8_t bad[16] = {0};

	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_INVALID_LENGTH, ef_auth_write_proof(&session, bad, 15, 0));
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_UNAVAILABLE, ef_auth_write_proof(&session, bad, 16, 0));
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_REJECTED, ef_auth_write_proof(&session, bad, 16, 100));
	TEST_ASSERT_FALSE(session.unlocked);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_INVALID_LENGTH, ef_auth_write_proof(&session, bad, 3, 200));
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_RATE_LIMITED, ef_auth_write_proof(&session, bad, 16, 2099));
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_UNAVAILABLE, ef_auth_write_proof(&session, bad, 16, 2100));
}

void test_retry_delay_is_global_across_sessions(void)
{
	ef_auth_session_t other;
	uint8_t bad[16] = {0};

	ef_auth_session_reset(&other);
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_REJECTED, ef_auth_write_proof(&session, bad, 16, 0));
	ef_auth_set_nonce(&other, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_RATE_LIMITED, ef_auth_write_proof(&other, session_proof, 16, 1999));
	TEST_ASSERT_EQUAL_UINT8(0, ef_auth_write_proof(&other, session_proof, 16, 2000));
}

void test_authorize_order_locked_missing_proof_and_bad_mac(void)
{
	uint8_t bad[16] = {0};

	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_REJECTED, ef_auth_authorize(&session, reboot_request, 9, 0));
	unlock();
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_UNAVAILABLE, ef_auth_authorize(&session, reboot_request, 9, 0));
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_REJECTED, ef_auth_authorize(&session, reboot_request, 9, 0));
	TEST_ASSERT_TRUE(session.nonce_valid);
	TEST_ASSERT_EQUAL_UINT8(0, ef_auth_write_proof(&session, bad, 16, 0));
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_REJECTED, ef_auth_authorize(&session, reboot_request, 9, 0));
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_RATE_LIMITED, ef_auth_write_proof(&session, command_proof, 16, 1));
}

void test_new_nonce_invalidates_staged_proof(void)
{
	unlock();
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(0, ef_auth_write_proof(&session, command_proof, 16, 0));
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_REJECTED, ef_auth_authorize(&session, reboot_request, 9, 0));
}

void test_missing_key_is_unavailable(void)
{
	ef_auth_init(NULL, uid);
	ef_auth_set_nonce(&session, nonce);
	TEST_ASSERT_EQUAL_UINT8(EF_ATT_ERR_UNAVAILABLE, ef_auth_write_proof(&session, session_proof, 16, 0));
}
