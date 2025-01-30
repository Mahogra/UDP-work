const dgram = require('dgram');
const WebSocket = require('ws');
const http = require('http');
const { enkripsi } = require('./encrypt.js');
const fs = require('fs');
const path = require('path');

// Create UDP socket for sending commands
const udpSocket = dgram.createSocket('udp4');

// PID Controller Parameters
const PID = {
    Kp: 1.7,
    Ki: 0.03,
    Kd: 0.17,
    min_pwm: 10,
    max_pwm: 100,
    stop_margin: 0.017,
    integral: 0,
    prev_error: 0,
    prev_time: Date.now(),
    target_angle: null,  // Changed to null to indicate no setpoint
    current_angle: 0
};

// Store device information
const deviceState = {
    port: 8766,
    address: null,
    authenticated: false,
    hasSetpoint: false  // New flag to track setpoint status
};

// Create HTTP server for web interface
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    }
});

// Create WebSocket server for feedback and web interface
const wss = new WebSocket.Server({ server });

function calculatePID(targetAngle, currentAngle) {
    if (targetAngle === null) {
        return { pwm: 0, error: 0 };
    }

    const current_time = Date.now();
    const dt = (current_time - PID.prev_time) / 1000;

    const error = targetAngle - currentAngle;
    PID.integral += error * dt;
    
    const maxIntegral = 50;
    PID.integral = Math.max(Math.min(PID.integral, maxIntegral), -maxIntegral);

    const derivative = dt > 0 ? (error - PID.prev_error) / dt : 0;
    const output = (PID.Kp * error) + (PID.Ki * PID.integral) + (PID.Kd * derivative);
    
    let pwm = Math.min(Math.max(Math.abs(output), PID.min_pwm), PID.max_pwm);
    pwm *= Math.sign(output);

    PID.prev_error = error;
    PID.prev_time = current_time;

    return {
        pwm: Math.round(pwm),
        error: error
    };
}

function sendUDPCommand(command) {
    if (!deviceState.address || !deviceState.hasSetpoint) {
        console.log('Cannot send command: Device not ready or no setpoint received');
        return;
    }

    // Convert IPv6 format to IPv4 if needed
    let ipAddress = deviceState.address;
    if (ipAddress.startsWith('::ffff:')) {
        ipAddress = ipAddress.substr(7);
    }

    try {
        const encryptedMessage = JSON.stringify(enkripsi(JSON.stringify(command)));
        udpSocket.send(
            encryptedMessage,
            deviceState.port,
            ipAddress,
            (err) => {
                if (err) {
                    console.error('UDP send error:', err);
                } else {
                    console.log(`UDP command sent to ${ipAddress}:${deviceState.port}: ${command}`);
                }
            }
        );
    } catch (error) {
        console.error('Error sending UDP command:', error);
    }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const clientType = req.headers.origin ? 'web' : 'device';
    let clientAddress = req.socket.remoteAddress;
    
    // Convert IPv6 to IPv4 if needed
    if (clientAddress.startsWith('::ffff:')) {
        clientAddress = clientAddress.substr(7);
    }
    
    console.log(`New ${clientType} client connected from ${clientAddress}`);

    ws.on('message', (message) => {
        if (clientType === 'web') {
            // Handle web client setpoint commands
            try {
                const setpoint = parseFloat(message.toString());
                if (!isNaN(setpoint)) {
                    console.log(`Received setpoint: ${setpoint}°`);
                    PID.target_angle = setpoint * Math.PI / 180;
                    deviceState.hasSetpoint = true;
                    
                    // Reset PID parameters for new setpoint
                    PID.integral = 0;
                    PID.prev_error = 0;
                    PID.prev_time = Date.now();

                    // Send command only if device is ready
                    if (deviceState.authenticated) {
                        const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                        sendUDPCommand(pidOutput.pwm);
                    }
                }
            } catch (error) {
                console.error('Error processing setpoint:', error);
            }
        } else {
            // Handle controller authentication and feedback
            if (!deviceState.authenticated) {
                try {
                    const authData = JSON.parse(message);
                    if (authData.name === "Sean" && authData.password === "bayar10rb") {
                        deviceState.authenticated = true;
                        deviceState.address = clientAddress;
                        ws.send("Authentication successful");
                        console.log(`Controller authenticated: ${clientAddress}`);
                    } else {
                        ws.close();
                    }
                } catch (error) {
                    console.error('Authentication error:', error);
                    ws.close();
                }
            } else {
                // Process position feedback only if we have a setpoint
                try {
                    const currentAngle = parseFloat(message);
                    if (!isNaN(currentAngle)) {
                        PID.current_angle = currentAngle;
                        console.log(`Position feedback: ${currentAngle * 180 / Math.PI}°`);
                        
                        if (deviceState.hasSetpoint) {
                            const pidOutput = calculatePID(PID.target_angle, PID.current_angle);
                            if (Math.abs(pidOutput.error) > PID.stop_margin) {
                                sendUDPCommand(pidOutput.pwm);
                            } else {
                                console.log('Target position reached');
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error processing feedback:', error);
                }
            }
        }
    });

    ws.on('close', () => {
        if (clientType === 'device') {
            deviceState.authenticated = false;
            deviceState.hasSetpoint = false;  // Reset setpoint flag when device disconnects
            PID.target_angle = null;  // Reset target angle
            console.log(`Controller disconnected: ${clientAddress}`);
        } else {
            console.log(`Web client disconnected: ${clientAddress}`);
        }
    });
});

// Start servers
const WS_PORT = 8765;
server.listen(WS_PORT, () => {
    console.log(`Server running on port ${WS_PORT}`);
    console.log(`WebSocket server: ws://localhost:${WS_PORT}`);
});
