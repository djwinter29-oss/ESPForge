/* SPDX-License-Identifier: BSD-3-Clause
 * Copyright (c) 2026 Ji Dong
 */

#include "platform/ef_platform.h"

#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/drivers/led_strip.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(espforge_led, LOG_LEVEL_INF);

static const struct device *const strip = DEVICE_DT_GET(DT_NODELABEL(espforge_led));
K_MUTEX_DEFINE(led_lock);
static uint8_t current_colour;
static uint8_t requested_colour;
static bool available;
static bool pending;

static int transmit(uint8_t colour)
{
	struct led_rgb pixel = {
		.r = colour & 1u ? 16 : 0,
		.g = colour & 2u ? 16 : 0,
		.b = colour & 4u ? 16 : 0,
	};

	return led_strip_update_rgb(strip, &pixel, 1);
}

static void led_worker(struct k_work *work)
{
	uint8_t colour;
	int err;

	ARG_UNUSED(work);
	k_mutex_lock(&led_lock, K_FOREVER);
	colour = requested_colour;
	k_mutex_unlock(&led_lock);
	err = transmit(colour);
	if (err != 0) {
		LOG_ERR("RGB LED update failed: %d", err);
	}
	k_mutex_lock(&led_lock, K_FOREVER);
	available = err == 0;
	if (available) {
		current_colour = colour;
	}
	pending = false;
	k_mutex_unlock(&led_lock);
}

K_WORK_DEFINE(led_work, led_worker);

void ef_platform_led_init(void)
{
	int err = device_is_ready(strip) ? transmit(0) : -ENODEV;

	/* The first SPI transfer configures MOSI; clear again after its reset/latch interval. */
	if (err == 0) {
		err = transmit(0);
	}
	if (err != 0) {
		LOG_ERR("RGB LED initialization failed: %d", err);
	}
	k_mutex_lock(&led_lock, K_FOREVER);
	available = err == 0;
	current_colour = 0;
	k_mutex_unlock(&led_lock);
}

int ef_platform_led_request(uint8_t colour)
{
	int err = 0;

	k_mutex_lock(&led_lock, K_FOREVER);
	if (colour > 7) {
		err = -EINVAL;
	} else if (!available) {
		err = -ENODEV;
	} else if (pending) {
		err = -EBUSY;
	} else {
		requested_colour = colour;
		pending = true;
		err = k_work_submit(&led_work);
		if (err < 0) {
			pending = false;
			LOG_ERR("RGB LED queue failed: %d", err);
		} else {
			err = 0;
		}
	}
	k_mutex_unlock(&led_lock);
	return err;
}

void ef_platform_led_status(uint8_t *colour, bool *ready)
{
	k_mutex_lock(&led_lock, K_FOREVER);
	*colour = available ? current_colour : 0;
	*ready = available;
	k_mutex_unlock(&led_lock);
}
