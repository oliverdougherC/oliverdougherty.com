#!/bin/sh

# Configure the emulated NIC as soon as Tiny Core finishes booting.
# Run in the background so a slow DHCP lease never blocks the desktop.
(
  sleep 1
  /usr/local/bin/retro-vm-network eth0 || true
) >/var/log/retro-vm-network.log 2>&1 &
