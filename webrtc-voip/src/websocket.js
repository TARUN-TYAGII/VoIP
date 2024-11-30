import React, { useState, useEffect, useRef, useCallback } from 'react';

const useWebSocket = (url) => {
    const [socket, setSocket] = useState(null);
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        const ws = new WebSocket(url);

        ws.onopen = () => {
            console.log('WebSocket Connected');
            setIsConnected(true);
            setSocket(ws);
        };

        ws.onclose = () => {
            console.log('WebSocket Disconnected');
            setIsConnected(false);
            setSocket(null);
        };

        return () => {
            ws.close();
        };
    }, [url]);

    const sendMessage = useCallback((message) => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    }, [socket]);

    return { socket, isConnected, sendMessage };
};
