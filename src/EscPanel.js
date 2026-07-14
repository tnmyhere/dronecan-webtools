import React, { useState, useEffect } from 'react';
import { Paper, Box, Typography, Card, CardContent, Slider, TextField, AppBar, Toolbar, Button, IconButton, Chip } from '@mui/material';
import PanToolIcon from '@mui/icons-material/PanTool';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import dronecan from './dronecan';

const commandValueType = new dronecan.DSDL.uavcan_equipment_esc_RawCommand().fields.cmd.value_type;
const CMD_MAX = Number(commandValueType.value_range.max);
const CMD_MIN = Number(commandValueType.value_range.min);

const ARMING_STATUS = dronecan.DSDL.uavcan_equipment_safety_ArmingStatus.CONSTANTS.status;
const SAFETY_STATE = dronecan.DSDL.ardupilot_indication_SafetyState.CONSTANTS.status;

const getScaledCommands = (thrustValues) => {
    return thrustValues.map(val => {
        if (val === 0) return 0;
        if (val > 0) {
            return Math.round((val / 100) * CMD_MAX);
        }
        return Math.round((val / 100) * Math.abs(CMD_MIN));
    });
};

const EscPanel = () => {
    const [escData, setEscData] = useState([]);
    const [thrustValues, setThrustValues] = useState([]);
    const [localInstances, setLocalInstances] = useState(4);
    // Single bus-wide arm/disarm toggle. Disarmed (the default) streams
    // SAFETY_ON + DISARMED and forces RawCommand thrust to 0; armed streams
    // SAFETY_OFF + FULLY_ARMED and lets slider thrust through.
    const [armed, setArmed] = useState(false);
    const [escNodeIds, setEscNodeIds] = useState([]); // node IDs seen publishing esc.Status
    const [nodeModes, setNodeModes] = useState({});
    const [broadcastRate, setBroadcastRate] = useState(10);  // Changed default to 10
    const [isPaused, setIsPaused] = useState(false);  // New state for pause toggle

    // Add toggle pause function
    const togglePause = () => {
        setIsPaused(!isPaused);
        console.log(`Broadcasting ${!isPaused ? 'paused' : 'resumed'}`);
    };

    // Add handler function for broadcast rate
    const handleBroadcastRateChange = (e) => {
        const newValue = parseInt(e.target.value) || 0;
        // Reasonable limits for broadcast rate
        const safeValue = Math.max(1, Math.min(1000, newValue));
        setBroadcastRate(safeValue);
        console.log('Broadcast rate changed to:', safeValue);
    };

    useEffect(() => {
        const localNode = window.opener.localNode;
        if (!localNode) return;
        const handleEscData = (transfer) => {
            const msg = transfer.payload;
            const msgObj = msg.toObj();
            // console.log('ESC data:', msgObj);
            const src = transfer.sourceNodeId;
            if (src != null) {
                setEscNodeIds(prev => (prev.includes(src) ? prev : [...prev, src]));
            }
            if (msgObj && typeof msgObj.esc_index === 'number' && msgObj.esc_index < localInstances) {
                const newEscData = [...escData];
                newEscData[msgObj.esc_index] = {
                    esc_index: msgObj.esc_index,
                    node_id: src,
                    error_count: msgObj.error_count,
                    temperature: msgObj.temperature,
                    voltage: msgObj.voltage,
                    current: msgObj.current,
                    rpm: msgObj.rpm,
                    power_rating_pct: msgObj.power_rating_pct
                };
                setEscData(newEscData);
            }
        };
        localNode.on('uavcan.equipment.esc.Status', handleEscData);
        return () => {
            localNode.off('uavcan.equipment.esc.Status', handleEscData);
        };
    }, [escData, localInstances]);

    // Poll ESC node modes for the status indicators, and watch the link. If the
    // connection drops, stop any arm/disarm stream and forget ESC state so we
    // don't keep trying to send frames or show stale indicators.
    useEffect(() => {
        const id = setInterval(() => {
            const opener = window.opener;
            const connected = opener?.mavlinkSession?.isConnected?.() === true;

            if (!connected) {
                setArmed(false);
                setEscNodeIds(prev => (prev.length ? [] : prev));
                setNodeModes(prev => (Object.keys(prev).length ? {} : prev));
                return;
            }

            const mons = opener?.localNode?.nodeMonitors || {};
            const modes = {};
            Object.keys(mons).forEach(k => { modes[k] = mons[k]?.status?.mode; });
            setNodeModes(modes);
        }, 500);
        return () => clearInterval(id);
    }, []);

    // Initialize thrust values array when instances change
    useEffect(() => {
        // Ensure instances is a valid positive number within reasonable limits
        const safeInstances = Math.max(1, Math.min(32, parseInt(localInstances) || 1));
        
        setThrustValues(Array(safeInstances).fill(0));
        
        // Initialize ESC data array with empty data
        const initialEscData = Array(safeInstances).fill(0).map((_, index) => ({
            esc_index: index,
            node_id: null,
            error_count: null,
            temperature: null,
            voltage: null,
            current: null,
            rpm: null,
            power_rating_pct: null
        }));
        setEscData(initialEscData);
    }, [localInstances]);

    const handleThrustChange = (index, value) => {
        const newThrustValues = [...thrustValues];
        newThrustValues[index] = value;
        setThrustValues(newThrustValues);
    };

    const handleThrustInputChange = (index, event) => {
        let value = parseInt(event.target.value);
        // Check bounds
        if (isNaN(value)) value = 0;
        value = Math.max(-100, Math.min(100, value));
        handleThrustChange(index, value);
    };

    const handleInstanceChange = (e) => {
        // Ensure we have a valid positive integer
        const newValue = parseInt(e.target.value) || 8;
        const newInstances = Math.max(1, Math.min(32, newValue));
        setLocalInstances(newInstances);
        console.log('ESC instances changed to:', newInstances);
    };

    // Define the stop all function
    const handleStopAll = () => {
        const newThrustValues = Array(thrustValues.length).fill(0);
        setThrustValues(newThrustValues);
        console.log('Stopping all ESCs');
    };
    
    // Define the stop one function
    const handleStopOne = (index) => {
        const newThrustValues = [...thrustValues];
        newThrustValues[index] = 0;
        setThrustValues(newThrustValues);
        console.log(`Stopping ESC ${index + 1}`);
    };

    // First, create the worker once (outside of any specific effect)
    useEffect(() => {
        if (!window.EscPanelWorker) {
            window.EscPanelWorker = new Worker(new URL('./workers/esc-command-worker.js', import.meta.url));
            console.log('Created ESC command worker');
        }
        
        // Set up message handler for all command types
        window.EscPanelWorker.onmessage = (event) => {
            const localNode = window.opener?.localNode;
            if (!localNode) return;
            
            if (event.data.type === 'requestEscCommand') {
                try {
                    if (thrustValues.length === 0) {
                        console.warn("Warning: thrustValues array is empty!");
                        return;
                    }
                    // Gate thrust on the arm state: send real thrust only when armed,
                    // otherwise force zeros. Keeps disarm safe even on ESCs with
                    // REQUIRE_ARMING=0, which ignore the ArmingStatus gate entirely.
                    const scaledCommands = armed
                        ? getScaledCommands(thrustValues)
                        : thrustValues.map(() => 0);
                    localNode.sendUavcanEquipmentEscRawCommand(0, scaledCommands);
                } catch (error) {
                    console.error('Error sending ESC commands:', error);
                }
            } else if (event.data.type === 'requestSafetyCommand') {
                try {
                    // arm -> SAFETY_OFF, disarm -> SAFETY_ON
                    const status = armed ? SAFETY_STATE.STATUS_SAFETY_OFF : SAFETY_STATE.STATUS_SAFETY_ON;
                    localNode.sendArdupilotIndicationSafetyState(0, status);
                } catch (error) {
                    console.error('Error sending safety message:', error);
                }
            } else if (event.data.type === 'requestArmingCommand') {
                try {
                    // arm -> FULLY_ARMED, disarm -> DISARMED
                    const status = armed ? ARMING_STATUS.STATUS_FULLY_ARMED : ARMING_STATUS.STATUS_DISARMED;
                    localNode.sendUavcanEquipmentSafetyArmingStatus(0, status);
                } catch (error) {
                    console.error('Error sending arming message:', error);
                }
            }
        };

        return () => {
            // No need to terminate the worker here since it's shared
        };
    }, [thrustValues, armed]); // Rebind so the handler sends the current arm/thrust state

    // ESC commands - managed by pause state
    useEffect(() => {
        if (!window.EscPanelWorker) return;
        
        if (!isPaused) {
            console.log(`Starting ESC commands with rate: ${broadcastRate}Hz`);
            window.EscPanelWorker.postMessage({
                type: 'esc',
                command: 'start',
                rate: broadcastRate
            });
        } else {
            console.log('Pausing ESC commands');
            window.EscPanelWorker.postMessage({
                type: 'esc',
                command: 'stop'
            });
        }
        
        return () => {
            window.EscPanelWorker.postMessage({
                type: 'esc',
                command: 'stop'
            });
        };
    }, [isPaused, broadcastRate]);

    // Safety + Arming stream - always running at 2Hz so the bus continuously
    // sees the current arm state (like ArduPilot). The worker onmessage handler
    // picks the value (armed vs disarmed) from the `armed` state. Streaming
    // DISARMED continuously is what actually keeps the ESCs disarmed.
    useEffect(() => {
        if (!window.EscPanelWorker) return;

        window.EscPanelWorker.postMessage({ type: 'safety', command: 'start' });
        window.EscPanelWorker.postMessage({ type: 'arming', command: 'start' });

        return () => {
            window.EscPanelWorker.postMessage({ type: 'safety', command: 'stop' });
            window.EscPanelWorker.postMessage({ type: 'arming', command: 'stop' });
        };
    }, []);

    // Online ESC count, scoped to nodes actually seen publishing esc.Status
    // and currently reporting NodeStatus (liveness).
    const onlineEscIds = escNodeIds.filter(id => nodeModes[id] !== undefined);
    const escCount = onlineEscIds.length;

    return (
        // Main container - add height and overflow handling
        <Box
            sx={{ 
                flexGrow: 1, 
                bgcolor: 'background.paper', 
                height: '100%', 
                width: '100%',
                display: 'flex',
                flexDirection: 'column'  // Make sure it's a column layout
            }} 
            component={Paper}
            p={1}
        >
            <AppBar position="static" color="primary" sx={{ mb: 2 }}>
                <Toolbar variant="dense" sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', mr: 1 }}>
                            <Typography variant="body2" sx={{ mr: 1 }}>Channels:</Typography>
                            <TextField
                                type="number"
                                size="small"
                                value={localInstances}
                                sx={{ width: '60px' }}  // Add specific width
                                InputProps={{ 
                                    inputProps: { 
                                        min: 1, 
                                        max: 20,
                                        style: { 
                                            textAlign: 'center',
                                            padding: '2px 4px'  // Reduce internal padding
                                        }
                                    }
                                }}
                                onChange={handleInstanceChange}
                            />
                        </Box>
                        
                        {/* ESC count indicator */}
                        <Chip
                            size="small"
                            label={escCount ? `${escCount} ESC${escCount > 1 ? 's' : ''} online` : 'No ESC'}
                            color={escCount ? 'success' : 'default'}
                            sx={{ ml: 2, height: 20 }}
                        />

                        {/* Add warning text */}
                        <Typography
                            variant="body2"
                            sx={{
                                color: 'error.main',
                                fontWeight: 'bold',
                                ml: 2,
                                mr: 2,
                                display: 'flex',
                                alignItems: 'center',
                                fontSize: '0.6rem'
                            }}
                        >
                            ⚠️ REMOVE PROPELLERS!
                        </Typography>
                    </Box>

                    {/* Controls on the right side */}
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        {/* Single bus-wide Arm/Disarm toggle; label shows the action */}
                        <Button
                            size="small"
                            variant="contained"
                            color={armed ? 'error' : 'success'}
                            onClick={() => {
                                const next = !armed;
                                if (next) setIsPaused(false); // let thrust flow when arming
                                setArmed(next);
                            }}
                            sx={{ mr: 2 }}
                        >
                            {armed ? 'Disarm' : 'Arm'}
                        </Button>

                        {/* Broadcast Rate moved to the right */}
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Typography variant="body2" sx={{ mr: 1 }}>Broadcast Rate:</Typography>
                            <TextField
                                type="number"
                                size="small"
                                value={broadcastRate}
                                sx={{ width: '60px' }}
                                InputProps={{ 
                                    inputProps: { 
                                        min: 1, 
                                        max: 1000,
                                        style: { 
                                            textAlign: 'center',
                                            padding: '2px 4px'
                                        }
                                    }
                                }}
                                onChange={handleBroadcastRateChange}
                            />
                            {/* Pause/Play toggle button */}
                            <IconButton 
                                size="small" 
                                onClick={togglePause}
                                sx={{ ml: 1 }}
                                color={isPaused ? "default" : "primary"}
                            >
                                {isPaused ? <PlayArrowIcon /> : <PauseIcon />}
                            </IconButton>
                        </Box>
                    </Box>
                </Toolbar>
            </AppBar>

            {/* Make the ESC cards section scrollable */}
            <Box sx={{ 
                display: 'flex', 
                flexWrap: 'wrap', 
                gap: 0.5,
                justifyContent: 'center',
                flexGrow: 1,
                overflowY: 'auto',  // Add scrolling
                minHeight: '150px',
                maxHeight: 'calc(100% - 140px)'  // Reserve space for header and footer
            }}>
                {escData.map((esc, index) => {
                    const hasEsc = esc.node_id != null;
                    const chStatusLabel = !hasEsc ? 'NO ESC' : (armed ? 'ARMED' : 'DISARMED');
                    const chStatusColor = !hasEsc ? 'default' : (armed ? 'success' : 'warning');
                    return (
                    <Box
                        key={index}
                        sx={{
                            width: '180px',
                            height: '250px',
                        }}
                    >
                        <Card variant="outlined" sx={{ height: '100%' }}>
                            <CardContent
                                sx={{
                                    height: '100%',
                                    display: 'flex',
                                    flexDirection: 'row',
                                    justifyContent: 'space-between',
                                }}
                            >
                                <Box sx={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    flexGrow: 1,
                                }}>
                                    <Box>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
                                            <Typography variant="body2" color="textSecondary">Index: {esc.esc_index}</Typography>
                                            <Chip
                                                label={chStatusLabel}
                                                size="small"
                                                color={chStatusColor}
                                                sx={{ height: 16, '& .MuiChip-label': { px: 0.5, fontSize: '0.55rem' } }}
                                            />
                                        </Box>
                                        <Typography variant="body2" color="textSecondary">Err: {esc.error_count !== null ? esc.error_count : "NC"}</Typography>
                                        <Typography variant="body2" color="textSecondary">
                                            Temp: {esc.temperature !== null ? `${(esc.temperature - 273.15).toFixed(1)} °C` : "NC"}
                                        </Typography>
                                        <Typography variant="body2" color="textSecondary">
                                            Volt: {esc.voltage !== null ? `${esc.voltage.toFixed(2)} V` : "NC"}
                                        </Typography>
                                        <Typography variant="body2" color="textSecondary">
                                            Curr: {esc.current !== null ? `${esc.current.toFixed(2)} A` : "NC"}
                                        </Typography>
                                        <Typography variant="body2" color="textSecondary">
                                            RPM: {esc.rpm !== null ? Math.round(esc.rpm) : "NC"}
                                        </Typography>
                                        <Typography variant="body2" color="textSecondary">
                                            RAT: {esc.power_rating_pct !== null ? `${esc.power_rating_pct.toFixed(1)} %` : "NC"}
                                        </Typography>
                                    </Box>
                                    
                                    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start', width: '80%' }}>
                                        <TextField
                                            type="number"
                                            size="small"
                                            value={thrustValues[index] || 0}
                                            fullWidth
                                            InputProps={{
                                                inputProps: {
                                                    min: -100,
                                                    max: 100,
                                                    style: {
                                                        padding: '2px 4px'
                                                    }
                                                }
                                            }}
                                            onChange={(e) => handleThrustInputChange(index, e)}
                                        />
                                        <Button
                                            color="error"
                                            variant="contained"
                                            onClick={() => handleStopOne(index)}
                                            fullWidth
                                            size="small"
                                        >
                                            Stop
                                        </Button>
                                    </Box>
                                </Box>
                                
                                <Box sx={{ 
                                    display: 'flex', 
                                    justifyContent: 'center',
                                    alignItems: 'space-between',
                                    height: '100%',
                                    paddingTop: '5px'
                                }}>
                                    <Slider
                                        sx={{ height: '100%' }}
                                        orientation="vertical"
                                        value={thrustValues[index] || 0}
                                        valueLabelDisplay="auto"
                                        step={1}
                                        marks={[
                                            { value: 100, label: '' },
                                            { value: 0, label: '' },
                                            { value: -100, label: '' }
                                        ]}
                                        min={-100}
                                        max={100}
                                        onChange={(e, value) => handleThrustChange(index, value)}
                                    />
                                </Box>
                            </CardContent>
                        </Card>
                    </Box>
                    );
                })}
            </Box>

            {/* Bottom controls section - ensure it stays at the bottom */}
            <Box sx={{ 
                mt: 1,
                width: '100%',
                flexGrow: 1,
                p: 0.5,
                gap: 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
            }}>
                <Box sx={{ p: 1, border: '1px solid #ddd', borderRadius: 1}}>
                    <Typography variant="body2" color="textSecondary">
                        cmd: [{getScaledCommands(thrustValues).join(', ')}]
                    </Typography>
                </Box>
                
                <Button
                    variant="contained"
                    color="error"
                    fullWidth
                    startIcon={<PanToolIcon />}
                    onClick={handleStopAll}
                >
                    Stop All
                </Button>
            </Box>
        </Box>
    );
};

export default EscPanel;