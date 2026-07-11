import React, { useEffect, useState, useRef } from 'react';
import { AppBar, Toolbar, Typography, Box, Button, ThemeProvider, IconButton, Snackbar, Alert, Tooltip, FormControl, Select, MenuItem, InputLabel, Chip } from '@mui/material';
import MavlinkSession from './mavlink_session';
import dronecan from './dronecan';
import theme from './theme';
import NodeList from './NodeList';
import NodeLogs from './NodeLogs';
import NodeProperties from './NodeProperties';
import NodeParam from './NodeParam';
import About from './About';
import ToolsMenu from './ToolsMenu';
import PanelsMenu from './PanelsMenu';
import ConnectionSettingsModal from './ConnectionSettingsModal';
import DronecanLogo from './image/dronecan_logo.png';
import FileServer from './FileServer';
import './css/index.css';
import ConnectionIndicators from './ConnectionIndicators';
import DnsIcon from '@mui/icons-material/Dns';
import LanIcon from '@mui/icons-material/Lan';
import BoltIcon from '@mui/icons-material/Bolt';
import CompactSidebar from './CompactSidebar';
import DNAServerModal from './DNAServerModal';

const MODE_MAINTENANCE = 2;   // uavcan.protocol.NodeStatus mode: MAINTENANCE

window.mavlinkSession = new MavlinkSession();
window.localNode = new dronecan.Node({name: "com.vimdrones.web_gui"});
localNode.on('sendFrame', (messageId, data, len) => {
    const msg = new mavlink20.messages.can_frame(
        mavlinkSession.targetSystem, // target_system
        mavlinkSession.targetComponent, // target_component
        localNode.bus,
        len,
        messageId,
        data.toString('binary')
    );
    mavlinkSession.sendMavlinkMsg(msg);
});


localNode.on('uavcan.protocol.file.Read.Request', (transfer) => {
    FileServer.handleReadRequest(transfer, localNode);
});

const App = () => {
    const [nodes, setNodes] = useState({});
    const [nodesUpdateTimestamp, setNodesUpdateTimestamp] = useState(0);
    const [isConnected, setIsConnected] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [selectedNodeId, setSelectedNodeId] = useState(null);
    const [multiNodeEditorEnable, setMultiNodeEditorEnable] = useState(false);
    const [subWindowRef, setSubWindowRef] = useState({});
    const [snackbarOpen, setSnackbarOpen] = useState(false);
    const [snackbarMessage, setSnackbarMessage] = useState('');
    const [snackbarSeverity, setSnackbarSeverity] = useState('info');
    const [selectedBus, setSelectedBus] = useState(0);
    const [dnaModalOpen, setDnaModalOpen] = useState(false);
    const [dnaServerActive, setDnaServerActive] = useState(false);
    const [arming, setArming] = useState(false);
    const armBurstRef = useRef(null);
    const [escNodeIds, setEscNodeIds] = useState([]);

    const openWindow = (windowTitle, windowPath, windowSize) => {
        if (subWindowRef[windowPath]) {
            subWindowRef[windowPath].focus();
            return;
        }
        const newWindow = window.open(windowPath, windowTitle, windowSize);
        if (newWindow) {
            subWindowRef[windowPath] = newWindow;
            setSubWindowRef(subWindowRef);

            newWindow.addEventListener('beforeunload', () => {
                subWindowRef[windowPath] = null;
                setSubWindowRef(subWindowRef);
            });
        } else {
            console.error(`Main: Failed to open ${windowName}`);
        }
    };

    const showMessage = (message, severity = 'info') => {
        setSnackbarMessage(message);
        setSnackbarSeverity(severity);
        setSnackbarOpen(true);
    };

    // Arm ESCs out of MAINTENANCE into OPERATIONAL.
    const handleArm = () => {
        const localNode = window.localNode;
        const anyInMaintenance = () =>
            Object.values(localNode.nodeMonitors || {}).some(n => n?.status?.mode === MODE_MAINTENANCE);

        if (!anyInMaintenance()) {
            showMessage('ESC already armed — restart to drop back into maintenance mode', 'info');
            return;
        }
        if (armBurstRef.current) return; // already arming

        showMessage('Arming in progress — REMOVE PROPELLERS!', 'warning');
        setArming(true);

        let count = 0;
        armBurstRef.current = setInterval(() => {
            try {
                localNode.sendUavcanEquipmentEscRawCommand(0, Array(8).fill(0));
                localNode.sendArdupilotIndicationSafetyState(0, 255);       // SAFETY_OFF
                localNode.sendUavcanEquipmentSafetyArmingStatus(0, 255);    // FULLY_ARMED
            } catch (error) {
                console.error('Arm: error sending arm command:', error);
            }
            count++;

            // Keep streaming through the whole arm sequence. Stop once no ESC is left in MAINTENANCE.
            if (!anyInMaintenance()) {
                clearInterval(armBurstRef.current);
                armBurstRef.current = null;
                setArming(false);
                showMessage('ESC armed (OPERATIONAL)', 'success');
            } else if (count >= 300) { // ~30s safety cap
                clearInterval(armBurstRef.current);
                armBurstRef.current = null;
                setArming(false);
                console.log('Arm: stopped after safety cap without an OPERATIONAL report');
            }
        }, 100);
    };

    // Disarm ESCs by restarting them (reboot -> back into MAINTENANCE).
    const handleDisarm = () => {
        const localNode = window.localNode;
        const targets = escNodeIds.filter(id => nodes[id]);
        if (targets.length === 0) {
            showMessage('No ESC nodes to disarm', 'info');
            return;
        }
        targets.forEach(id => localNode.restartNode(Number(id)));
        showMessage(`Disarming ${targets.length} ESC node(s) — restarting to maintenance`, 'info');
    };

    // Remember which nodes are ESCs (they publish esc.Status while operational).
    useEffect(() => {
        const handleEscStatus = (transfer) => {
            const src = transfer.sourceNodeId;
            if (src != null) {
                setEscNodeIds(prev => (prev.includes(src) ? prev : [...prev, src]));
            }
        };
        localNode.on('uavcan.equipment.esc.Status', handleEscStatus);
        return () => {
            localNode.off('uavcan.equipment.esc.Status', handleEscStatus);
        };
    }, []);

    // Stop any in-flight arm stream when the app unmounts.
    useEffect(() => {
        return () => {
            if (armBurstRef.current) {
                clearInterval(armBurstRef.current);
                armBurstRef.current = null;
            }
        };
    }, []);

    // Check whether ESCs are armed or not, and update the toolbar button accordingly.
    const onlineEscNodeIds = escNodeIds.filter(id => nodes[id]);
    const escArmed = onlineEscNodeIds.length > 0
        && onlineEscNodeIds.every(id => nodes[id]?.status?.mode !== MODE_MAINTENANCE);

    const handleConnectionStatusChange = (isConnected) => {
        setIsConnected(isConnected);
        showMessage(
            isConnected ? 'Successfully connected to device' : 'Disconnected from device',
            isConnected ? 'success' : 'info'
        );
    };

    const handleBusChange = (event) => {
        const newBus = event.target.value;
        if (newBus === selectedBus) return;
        setSelectedBus(newBus);
        
        if (window.localNode) {
            window.localNode.changeBus(newBus);
            showMessage(`Switched to CAN bus ${newBus}`, 'info');
        }
    };

    const handleNodeList = (nodeList) => {
        setNodes(nodeList);
        setNodesUpdateTimestamp(Date.now());
    };

    useEffect(() => {
        localNode.on('nodeList', handleNodeList);
        return () => {
            localNode.off('nodeList');
        };
    }, []);

    const handleOpenModal = () => {
        setModalOpen(true);
    };

    const handleCloseModal = (serverRunning) => {
        setModalOpen(false);
        setDnaServerActive(serverRunning);
    };

    const handleOpenDnaModal = () => {
        setDnaModalOpen(true);
    };

    const handleCloseDnaModal = (serverRunning) => {
        setDnaModalOpen(false);
        setDnaServerActive(serverRunning);
    };

    return (
        <ThemeProvider theme={theme}>
            <AppBar position="static">
                <Toolbar variant="dense" sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Box sx={{width: '30%', flexGrow: 1, display: 'flex', flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center'}}> 
                        <ToolsMenu openWindow={openWindow.bind(this)} />
                        <PanelsMenu openWindow={openWindow.bind(this)} />
                        <Tooltip title={
                            !isConnected ? 'Connect an adapter first'
                            : escArmed ? 'Restart all ESC nodes to drop them back into MAINTENANCE'
                            : 'Arm all ESCs on the bus out of MAINTENANCE into OPERATIONAL. REMOVE PROPELLERS!'
                        }>
                            <span>
                                <Button
                                    color={escArmed ? 'error' : 'success'}
                                    disableElevation
                                    disabled={!isConnected || arming}
                                    onClick={escArmed ? handleDisarm : handleArm}
                                    startIcon={<BoltIcon />}
                                >
                                    {arming ? 'Arming…' : escArmed ? 'Disarm ESC nodes' : 'Arm ESC'}
                                </Button>
                            </span>
                        </Tooltip>
                    </Box>
                    <Box sx={{flexGrow: 2, display: 'flex', flexDirection: 'row', justifyContent: 'center', alignItems: 'center'}}>
                        <Box sx={{display: 'flex', flexDirection: 'row', alignItems: 'center'}} ml={0.5} mr={0.5}>
                            <a href="https://dev.vimdrones.com" target="_blank" rel="noreferrer" style={{height: 30}}>
                                <img src={DronecanLogo} alt="DroneCAN" style={{ height: 30}} />
                            </a>
                        </Box>
                        <Typography variant="caption">
                            DroneCAN Web Tools 
                        </Typography>
                    </Box>
                    <Box sx={{width: '30%', flexGrow: 1, display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 1}}> 
                        <ConnectionIndicators 
                            isConnected={isConnected}
                            mavlinkSession={window.mavlinkSession}
                            localNode={window.localNode}
                        />
                        
                        <FormControl 
                            size="small" 
                            sx={{ 
                                minWidth: 80,
                                '& .MuiOutlinedInput-root': {
                                    height: 30,
                                },
                                '& .MuiSelect-select': {
                                    paddingTop: 0.5, 
                                    paddingBottom: 0.5,
                                    fontSize: '0.8rem'
                                }
                            }}
                        >
                            <Select
                                value={selectedBus}
                                onChange={handleBusChange}
                                displayEmpty
                                variant="outlined"
                                sx={{
                                    backgroundColor: 'background.paper',
                                }}
                            >
                                <MenuItem value={0}>Bus 1</MenuItem>
                                <MenuItem value={1}>Bus 2</MenuItem>
                                <MenuItem value={2}>Bus 3</MenuItem>
                                <MenuItem value={3}>Bus 4</MenuItem>
                            </Select>
                        </FormControl>

                        <Button 
                            variant="outlined" 
                            color={dnaServerActive ? "success" : "primary"}
                            startIcon={
                                dnaServerActive ? 
                                <DnsIcon sx={{
                                    animation: 'pulse 1.5s infinite',
                                    '@keyframes pulse': {
                                        '0%': { opacity: 0.6 },
                                        '50%': { opacity: 1 },
                                        '100%': { opacity: 0.6 },
                                    }
                                }} /> : 
                                <DnsIcon />
                            }
                            onClick={handleOpenDnaModal}
                            sx={dnaServerActive ? {
                                borderColor: 'success.main',
                                '&:hover': {
                                    backgroundColor: 'rgba(76, 175, 80, 0.08)',
                                    borderColor: 'success.dark'
                                }
                            } : {}}
                        >
                            DNA
                        </Button>
                        
                        <Button 
                            variant="contained" 
                            color="primary" 
                            startIcon={<LanIcon />}
                            onClick={handleOpenModal}
                        >
                            Adapter
                        </Button>
                    </Box>
                </Toolbar>
            </AppBar>
            <Box sx={{ display: 'flex', flexDirection: 'row', flexGrow: 1, height: '95vh', gap: 0.5, p: 1 }}>
                <CompactSidebar 
                    nodes={nodes}
                    selectedNodeId={selectedNodeId}
                    setSelectedNodeId={setSelectedNodeId}
                    nodesUpdateTimestamp={nodesUpdateTimestamp}
                />
                
                <Box 
                    sx={{ 
                        minWidth: 550, 
                        display: { xs: 'none', md: 'flex' }, 
                        flexDirection: 'column', 
                        gap: 0.5, 
                    }}
                >
                    <NodeList
                        nodes={nodes}
                        selectedNodeId={selectedNodeId}
                        setSelectedNodeId={setSelectedNodeId.bind(this)}
                        nodesUpdateTimestamp={nodesUpdateTimestamp}
                    />
                    <NodeLogs/> 
                </Box>
                
                <Box 
                    display="flex" 
                    flexDirection="column" 
                    sx={{
                        gap: 0.5,
                        ml: { xs: 1, md: 0 },
                        flexGrow: 1,
                    }}
                >
                    {selectedNodeId && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, gap: 0.5 }}>
                            <NodeProperties
                                nodeId={selectedNodeId}
                                nodes={nodes}
                                multiNodeEditorEnable={multiNodeEditorEnable}
                                setMultiNodeEditorEnable={setMultiNodeEditorEnable.bind(this)}
                                nodesUpdateTimestamp={nodesUpdateTimestamp}
                            />
                            <NodeParam
                                nodeId={selectedNodeId}
                                nodes={nodes}
                                multiNodeEditorEnable={multiNodeEditorEnable}
                            />
                        </Box>
                    )}

                    {selectedNodeId === null && (
                        <About />
                    )}
                </Box>
            </Box>
            <ConnectionSettingsModal
                open={modalOpen}
                onClose={handleCloseModal}
                onConnectionStatusChange={handleConnectionStatusChange}
                showMessage={showMessage.bind(this)}
                selectedBus={selectedBus}
                onBusChange={handleBusChange}
            />
            <DNAServerModal
                open={dnaModalOpen}
                onClose={handleCloseDnaModal}
                showMessage={showMessage.bind(this)}
            />
            <Snackbar
                open={snackbarOpen} 
                autoHideDuration={6000} 
                onClose={() => setSnackbarOpen(false)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
                <Alert onClose={() => setSnackbarOpen(false)} severity={snackbarSeverity}>
                    {snackbarMessage}
                </Alert>
            </Snackbar>
        </ThemeProvider>
    );
};

export default App;