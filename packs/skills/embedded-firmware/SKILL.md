---
name: embedded-firmware
description: Write, build and debug microcontroller firmware (Arduino, ESP32, STM32, Raspberry Pi Pico).
source: you
uses: 0
category: Electrical Engineering
triggers: arduino, esp32, stm32, raspberry pi pico, microcontroller, firmware, platformio, i2c, spi, uart
---

1. Identify the board, toolchain and framework (Arduino CLI, PlatformIO, ESP-IDF, STM32Cube, Pico SDK); check what's installed with run_command.
2. Read the pinout and peripheral docs first: voltage levels, which pins do PWM/ADC/I2C/SPI, boot-strap pins to avoid.
3. Start from a minimal working example (blink, serial print), build it, then add one peripheral at a time.
4. Non-blocking design: state machines or timers instead of long delays; short interrupt handlers, shared variables volatile.
5. Build with the CLI (pio run, arduino-cli compile) and fix warnings that matter. Flashing hardware is the user's step unless they ask.
6. Report the wiring (pin -> part table), how to build and flash, and how to check it works.
