#ifndef ESPFORGE_CREDENTIALS_H
#define ESPFORGE_CREDENTIALS_H

#include <stddef.h>

int credential_decode(const char *hex, char *output, size_t capacity);
int credentials_validate(const char *ssid, const char *psk);

#endif
