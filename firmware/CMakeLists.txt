cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(espforge)
target_sources(app PRIVATE
  src/main.c
  src/config/board.c
  src/platform/boot_config.c
  src/platform/boot_flash.c
  src/platform/system_clock.c
  src/app/telemetry.c
  src/app/control/control.c
  src/app/storage/storage.c
  src/app/usb/hid_reports.c
  src/app/usb/usb_hid.c
  src/app/wireless/sha256.c
  src/app/wireless/wireless_auth.c
  src/app/wireless/wireless_stage.c
  src/app/wireless/bluetooth/ble.c
  src/app/wireless/wifi/wifi.c)
target_include_directories(app PRIVATE src)
if(DEFINED ENV{ESPFORGE_VERSION} AND NOT "$ENV{ESPFORGE_VERSION}" STREQUAL "")
  if(NOT "$ENV{ESPFORGE_VERSION}" MATCHES "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
    message(FATAL_ERROR "ESPFORGE_VERSION must be MAJOR.MINOR.PATCH with no leading zeros")
  endif()
  target_compile_definitions(app PRIVATE "ESPFORGE_VERSION=\"$ENV{ESPFORGE_VERSION}\"")
endif()
