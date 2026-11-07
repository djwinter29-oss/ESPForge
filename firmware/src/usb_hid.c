/*
 * Vendor HID interface on the native USB OTG port: Feature 1, 2, 12 and 20, Input 3 and 10 (docs/reference/usb-hid.md
 * with the docs/reference/espforge-profile.md adaptations).
 */
#include "espforge.h"
#include "control.h"

#include <errno.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/usb/class/usbd_hid.h>
#include <zephyr/usb/usbd.h>

LOG_MODULE_REGISTER(ef_usb, LOG_LEVEL_INF);

#define EF_USB_VID 0xCAFE
#define EF_USB_PID 0x4021
#define TELEMETRY_PERIOD_MS 250
#define STORAGE_PERIOD_MS 500

#define FEATURE(id, size) 0x85, (id), 0x95, (size), 0x09, (id), 0xB1, 0x02
#define INPUT(id, size) 0x85, (id), 0x95, (size), 0x09, (id), 0x81, 0x02

static const uint8_t report_descriptor[] = {
	0x06, 0x00, 0xFF,
	0x09, 0x01,
	0xA1, 0x01,
	0x15, 0x00,
	0x26, 0xFF, 0x00,
	0x75, 0x08,
	FEATURE(EF_REPORT_IDENTITY, EF_IDENTITY_SIZE),
	FEATURE(EF_REPORT_CONFIG, EF_CONFIG_SIZE),
	INPUT(EF_REPORT_TELEMETRY, EF_TELEMETRY_SIZE),
	INPUT(EF_REPORT_STORAGE, EF_STORAGE_SIZE),
	FEATURE(EF_REPORT_CONTROL, EF_CONTROL_SIZE),
	FEATURE(EF_REPORT_WIRELESS, EF_WIRELESS_SIZE),
	0xC0,
};

USBD_DEVICE_DEFINE(espforge_usbd, DEVICE_DT_GET(DT_NODELABEL(zephyr_udc0)), EF_USB_VID, EF_USB_PID);
USBD_DESC_LANG_DEFINE(espforge_lang);
USBD_DESC_MANUFACTURER_DEFINE(espforge_manufacturer, "djwinter29");
USBD_DESC_PRODUCT_DEFINE(espforge_product, "ESPForge");
USBD_DESC_CONFIG_DEFINE(espforge_config_name, "HID");
USBD_CONFIGURATION_DEFINE(espforge_config, 0, 100, &espforge_config_name);

/* The serial is Report 1's 8-byte UID; Zephyr's hwinfo serial would carry only the 6-byte MAC. */
static uint8_t serial_ascii[2 * EF_UID_SIZE + 1];
static struct usbd_desc_node espforge_serial = {
	.str = {
		.utype = USBD_DUT_STRING_SERIAL_NUMBER,
		.ascii7 = true,
	},
	.ptr = serial_ascii,
	.bLength = USB_STRING_DESCRIPTOR_LENGTH("0000000000000000"),
	.bDescriptorType = USB_DESC_STRING,
};

static const struct device *const hid = DEVICE_DT_GET(DT_NODELABEL(espforge_hid));

static atomic_t ready;
static atomic_t in_flight;
static uint8_t input[1 + EF_STORAGE_SIZE] __aligned(4);
static uint8_t telemetry_sequence;
static uint8_t storage_sequence;
static int64_t telemetry_at;
static int64_t storage_at;

static void iface_ready(const struct device *dev, const bool is_ready)
{
	ARG_UNUSED(dev);
	atomic_set(&ready, is_ready);
	atomic_clear(&in_flight);
	LOG_INF("HID interface %s", is_ready ? "ready" : "not ready");
}

static int get_report(const struct device *dev, const uint8_t type, const uint8_t id, const uint16_t len,
		      uint8_t *const buf)
{
	uint16_t size;

	ARG_UNUSED(dev);
	if (type == HID_REPORT_TYPE_FEATURE) {
		size = id == EF_REPORT_IDENTITY ? EF_IDENTITY_SIZE :
		       id == EF_REPORT_CONFIG	? EF_CONFIG_SIZE :
		       id == EF_REPORT_WIRELESS ? EF_WIRELESS_SIZE :
		       id == EF_REPORT_CONTROL	? EF_CONTROL_SIZE : 0;
	} else if (type == HID_REPORT_TYPE_INPUT) {
		size = id == EF_REPORT_TELEMETRY ? EF_TELEMETRY_SIZE : id == EF_REPORT_STORAGE ? EF_STORAGE_SIZE : 0;
	} else {
		size = 0;
	}
	if (size == 0 || len < size + 1) {
		return -ENOTSUP;
	}

	buf[0] = id;
	switch (id) {
	case EF_REPORT_IDENTITY:
		ef_identity_report(buf + 1);
		break;
	case EF_REPORT_CONFIG:
		ef_config_report(buf + 1);
		break;
	case EF_REPORT_WIRELESS:
		ef_wireless_report(buf + 1);
		break;
	case EF_REPORT_CONTROL:
		ef_lock();
		ef_control_usb_get(buf + 1);
		ef_unlock();
		break;
	case EF_REPORT_TELEMETRY:
		/* GET_REPORT samples carry sequence 0; only published Input reports advance the sequence. */
		ef_telemetry_report(0, buf + 1);
		break;
	default:
		ef_storage_report(0, buf + 1);
		break;
	}
	return size + 1;
}

static int set_report(const struct device *dev, const uint8_t type, const uint8_t id, const uint16_t len,
		      const uint8_t *const buf)
{
	bool accepted;

	ARG_UNUSED(dev);
	if (type != HID_REPORT_TYPE_FEATURE || id != EF_REPORT_CONTROL || len != EF_CONTROL_SIZE + 1 ||
	    buf[0] != EF_REPORT_CONTROL) {
		return -ENOTSUP;
	}
	ef_lock();
	accepted = ef_control_usb_set(buf + 1, EF_CONTROL_SIZE, k_uptime_get());
	ef_unlock();
	/* A rejected envelope stalls the status stage and leaves the previous result readable. */
	return accepted ? 0 : -EINVAL;
}

static void input_report_done(const struct device *dev, const uint8_t *const report)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(report);
	atomic_clear(&in_flight);
}

static const struct hid_device_ops hid_ops = {
	.iface_ready = iface_ready,
	.get_report = get_report,
	.set_report = set_report,
	.input_report_done = input_report_done,
};

static bool submit(uint8_t id)
{
	uint16_t size;

	if (!atomic_cas(&in_flight, 0, 1)) {
		return false;
	}
	input[0] = id;
	if (id == EF_REPORT_TELEMETRY) {
		ef_telemetry_report(++telemetry_sequence, input + 1);
		size = 1 + EF_TELEMETRY_SIZE;
	} else {
		ef_storage_report(++storage_sequence, input + 1);
		size = 1 + EF_STORAGE_SIZE;
	}
	if (hid_device_submit_report(hid, size, input) != 0) {
		atomic_clear(&in_flight);
		return false;
	}
	return true;
}

void ef_usb_poll(void)
{
	int64_t now = k_uptime_get();

	if (!atomic_get(&ready)) {
		return;
	}
	if (now - telemetry_at >= TELEMETRY_PERIOD_MS && submit(EF_REPORT_TELEMETRY)) {
		telemetry_at = now;
	} else if (now - storage_at >= STORAGE_PERIOD_MS && submit(EF_REPORT_STORAGE)) {
		storage_at = now;
	}
}

bool ef_usb_configured(void)
{
	return atomic_get(&ready) != 0;
}

int ef_usb_init(void)
{
	int err;

	if (!device_is_ready(hid)) {
		LOG_ERR("HID device not ready");
		return -ENODEV;
	}
	err = hid_device_register(hid, report_descriptor, sizeof(report_descriptor), &hid_ops);
	if (err) {
		return err;
	}
	memcpy(serial_ascii, ef_board_serial(), sizeof(serial_ascii));

	err = usbd_add_descriptor(&espforge_usbd, &espforge_lang);
	err = err ? err : usbd_add_descriptor(&espforge_usbd, &espforge_manufacturer);
	err = err ? err : usbd_add_descriptor(&espforge_usbd, &espforge_product);
	err = err ? err : usbd_add_descriptor(&espforge_usbd, &espforge_serial);
	err = err ? err : usbd_add_configuration(&espforge_usbd, USBD_SPEED_FS, &espforge_config);
	err = err ? err : usbd_register_all_classes(&espforge_usbd, USBD_SPEED_FS, 1, NULL);
	if (err) {
		LOG_ERR("USB device setup failed: %d", err);
		return err;
	}
	usbd_device_set_code_triple(&espforge_usbd, USBD_SPEED_FS, 0, 0, 0);
	err = usbd_init(&espforge_usbd);
	err = err ? err : usbd_enable(&espforge_usbd);
	if (err) {
		LOG_ERR("USB enable failed: %d", err);
	}
	return err;
}
