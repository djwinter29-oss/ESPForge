#ifndef ESPFORGE_H
#define ESPFORGE_H

#include <stddef.h>

#ifndef ESPFORGE_VERSION
#define ESPFORGE_VERSION "0.1.0"
#endif
#define ESPFORGE_STATUS_SIZE 512
#define ESPFORGE_REQUEST_SIZE 512

int status_json(char *buffer, size_t size);
void wireless_init(void);
int wireless_connect(const char *ssid, const char *psk);
void wireless_status(int *wifi_error, int *ble_error, int *connected);
void storage_init(void);
int storage_error(void);

#endif
