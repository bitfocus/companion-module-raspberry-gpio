# Module for local control of Raspberry Pi GPIO #

## About the module ##
This module is intended to run on CompanionPi, since it can only control GPIO pins locally. For such type of control it
utilizes *onoff* module for node.js.

## Actions ##
The module provides following actions:
- ***Set pin LOW (eg. 0)*** - this action sets the logic value of the pin to 0.
- ***Set pin HIGH (eg. 1)*** - this action sets the logic value of the pin to 1.

## Feedbacks ##
The module also provides feedback for logic state of configured pins. It can read state of both types of pins - these configured as inputs and also these configured as outputs.

## Variables ##
The module provides user accessible variables reflecting logic state of all configured pins. When apllying config, their list will occur on the bottom of module config window.

## Presets ##
The module utilizes its actions and feedbacks in presets.
The list of provided presets:
- ***Set GPIO Pin HIGH*** - this preset consists of *Set pin HIGH* action and state feedback for the pin.
- ***Set GPIO Pin LOW*** - this preset consists of *Set pin LOW* action and state feedback for the pin.
- ***GPIO pin pushbutton*** - this preset incorporates *Set pin HIGH* action as *key down action* and *Set pin LOW* action as *key up/release action*, it also involves pin state feedback.
- ***GPIO Pin LATCH button*** - this preset has the same features as the previous one, but it also configures the button to *latch* mode. That way *key down action* executes on the first push and *key up/release asction* executes on the second push.

## Configuration ##
The module configuration is pretty straightforward. 
There are 27 GPIO pins on newer Raspberry Pi, so for each GPIO pin there are these configuration options:
- ***Use GPIO pin*** - the most important checkbox for every pin - has to be checked when the pin is used, without checking this checkbox, the pin is not configured
- ***Set as IN/OUT*** - this option sets the pin as *input* or *output*
    - ***OUT*** - when the pin is set as *output*, all the remaining config fields should be left in default state.
- ***Trigger type*** - this option sets the interrupt to pin configured as *input*. The interrupt allows the module to refresh all feedbacks and state variables right at the moment when the signal on the input pin changes.
There are following options:
    - ***NONE*** - the interrupt is not enabled for pin
    - ***RISING*** - this sets the interrupt to be triggered when the input signal logic value changes from *LOW* to *HIGH* (eg. *0* to *1*)
    - ***FALLING*** - this sets the interrupt to be triggered when the input signal logic value changes from *HIGH* to *LOW* (eg. *1* to *0*)
    - ***RISING+FALLING*** - this sets the interrupt to be triggered on both events mentioned in previous two options
- ***Enable debouncing*** - this checkbox enables debouncing algorithm on previosly set interrupt. Debouncing is needed especially when working with push buttons and similar devices, because these parts are not mechanically perfect and when pushed or released, they generate volatile signal, "randomly" changing from *0* to *1*, and we don't want the module to register all the changes but only one.
- ***Debounce time*** - this option allows user to set timeout for debounce algorithm
- ***Invert values on this pin*** - this option inverts the logic values on the input pin, when the input signal is *LOW* (eg. *0*) the value read from pin is *HIGH* (eg. *1* and when the input signal is *HIGH* (eg. *1*) the value read from pin is *LOW* (eg. *0*)

The module also reads the current state of all configured pins regularly with adjustable interval. This interval is set on top od config window - option ***GPIO Pins state refresh interval (ms)***

## M5Stack Chain ##
The module can also read M5Stack Chain units (Key, Encoder, Joystick, Angle, Switch, Pedal, ToF, PIR) daisy-chained on one of the Pi's serial ports. Each unit gets its own variables, and new units are picked up while the module runs.

### Wiring ###
Chain units talk 3.3 V UART at 115200 baud and take 5 V power, so they connect straight to the Pi header:

| Chain cable | Pi header |
|---|---|
| 5V (red) | pin 2 or 4 |
| GND (black) | pin 6 |
| signal | pin 8 (GPIO14, TXD) |
| signal | pin 10 (GPIO15, RXD) |

Plug the cable into the first unit's input side. If the module says no unit answers, swap the two signal wires.

The Pi's UART has to be on and its serial console off: run `sudo raspi-config`, go to *Interface Options*, *Serial Port*, answer *No* to the login shell and *Yes* to the serial port hardware, then reboot. On a Pi 3, 4 or Zero W, adding `dtoverlay=disable-bt` to `/boot/firmware/config.txt` gives the Chain the full UART instead of the mini UART, whose speed drifts with the CPU clock.

While the Chain uses `/dev/serial0` (GPIO14 and GPIO15), those two pins can't be set up as plain GPIO pins below.

A USB serial adapter (`/dev/ttyUSB0`) works too and leaves the GPIO pins free.

### Settings ###
- ***Use a Chain bus*** - turns the Chain part of the module on.
- ***Serial port*** - `/dev/serial0` for GPIO14/15, or any other port. *Simulated Chain* runs without hardware, with the units listed in *Simulated units*.
- ***Pause between polls*** - the module asks every unit for its state in turn, then waits this long.
- ***Units found*** - every unit the module has seen, and whether it is connected now. Each one gets a name, which is the prefix of its variables. Units stay in the list when unplugged, so their settings come back with them; tick *Forget units that are not connected* and save to clear them out.

### Variables ###
Per unit, with its name as prefix (for example `encoder1_value`):
- Key: `pressed` (0/1), `click` (single, double, long)
- Encoder: `value` (count), `delta` (last turn), `pressed`, `click`
- Joystick: `x` and `y` (-100..100), `pressed`, `click`
- Angle: `value` (0-100 %), `raw` (0-4095)
- Switch: `value`, `raw`, `on`
- Pedal: `pressed`, `click`, `on`
- ToF: `distance` (mm)
- PIR: `person` (0/1)
- every unit: `online` (0/1)

Plus `chain_status` and `chain_count` for the bus.

### Actions and feedbacks ###
- ***Chain: set unit LED*** - colour and brightness of a unit's LED.
- ***Chain: reset encoder count***
- ***Chain: rescan the bus***
- Feedbacks: *button held*, *last click was*, *unit is connected* and *unit value compare*.

With the simulated Chain, *Chain simulator: operate a unit* and *Chain simulator: plug a unit onto the end* stand in for the hardware.

### Chain as a Companion surface ###
With ***Register as a surface*** on, the module connects to Companion's Satellite API (port 16622) and the Chain appears under *Surfaces* like any other surface, so it follows whatever page you give it there.
- Every Key, Encoder, Joystick, Pedal, Angle and Switch gets a key on that surface, in chain order. Change it per unit with *Key on the Chain surface* (0 takes the unit off the surface).
- Buttons press their key. Encoders, angles and switches turn it, so turn on *Enable rotary actions* on those buttons. *Angle/slider: raw units per surface step* sets how far an angle or switch moves per step.
- A unit's LED takes the colour of its key (see *Unit LEDs* below).

### Patches ###
A patch sends one unit to a button somewhere else. Set *Number of patches* and save to get their fields.
- ***Input***
    - *Turn* - an encoder steps the target by its turn, an angle or switch by one step per *raw units per step*.
    - *Joystick X / Y* - one step when the stick leaves the *dead zone*, then repeats while it is held, faster the further it is pushed.
    - *Button* - one step in the chosen direction per press, repeating while held.
    - *Two buttons* - the unit turns left and the *second button* turns right.
- ***Does*** - *Turn* steps the target left or right; *Press* presses and releases it with the button or stick.
- ***Target***
    - *Button at page/row/column* - a fixed button, through Companion's HTTP API (*Companion HTTP host/port*, 127.0.0.1:8000 by default). Works without the surface.
    - *Key on the Chain surface* - a key of the surface above, so it follows the page that surface is on.
    - *Turn value in this module* - a number between *Min* and *Max* in steps of *Step*, shown as variable `value_<name>`, with the action *Chain: set or adjust a turn value* and the feedback *Chain: turn value compare*.

Turning a button needs *Enable rotary actions* on it.

### Unit LEDs ###
Each unit's LED shows, in this order:
1. the colour of the button it is patched to, when the patch has *Unit LED shows the target's colour* on. For a button at page/row/column this needs Companion's *Settings*, *Satellite*, *Button Subscriptions API* turned on; the module says so in its log when it is off.
2. the colour of its key on the Chain surface;
3. otherwise the colour from the action ***Chain: set the colour of an unpatched unit***. That action only lists units that follow nothing, and the colour comes back when the unit is plugged in again.

A unit's *LED* setting *Set by actions only* skips the first two.

***LED colours from buttons*** - *Vivid* (default) shows button colours the way the ATOM Matrix does: a colourful button at full brightness with its saturation pushed 30 % toward full, a white or light grey button as white, a dark one as off, then gamma 2.2. *Exact* passes the button colour through unchanged. Colours from the action are always shown as picked.
