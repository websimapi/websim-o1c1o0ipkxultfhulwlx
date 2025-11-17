import { PLAYER_STATE } from './player-state.js';
import { updateAction } from './behaviors/player-behavior-updater.js';
import { startChoppingCycle } from './behaviors/chopping.js';
import { startGatheringCycle } from './behaviors/gathering.js';
import { renderPlayer } from './player-renderer.js';
import { TILE_TYPE } from './map-tile-types.js';
import { findPath } from './pathfinding.js';
import { beginChopping, beginHarvestingBushes, beginHarvestingLogs } from './behaviors/index.js';
import { PlayerEnergy } from './player-energy.js';
import { PlayerInventory } from './player-inventory.js';
import { PlayerSkills } from './player-skills.js';
import { applySeparation } from './player-movement.js';

export const ENERGY_DURATION_MS = 3600 * 1000; // This will now be controlled by settings

function findNearestEmptySpot(gridX, gridY, gameMap) {
    if (!gameMap.isCollidingForPathfinding(gridX, gridY)) {
        return { x: gridX, y: gridY };
    }

    let radius = 1;
    // Limit search radius to prevent infinite loops on a completely full map
    while (radius < Math.max(gameMap.width, gameMap.height) / 2) { 
        for (let i = -radius; i <= radius; i++) {
            for (let j = -radius; j <= radius; j++) {
                // Only check the perimeter of the search square
                if (Math.abs(i) !== radius && Math.abs(j) !== radius) {
                    continue;
                }

                const newX = gridX + i;
                const newY = gridY + j;

                if (newX >= 0 && newX < gameMap.width && newY >= 0 && newY < gameMap.height) {
                    if (!gameMap.isCollidingForPathfinding(newX, newY)) {
                        return { x: newX, y: newY };
                    }
                }
            }
        }
        radius++;
    }

    console.error(`Could not find any empty spot near (${gridX}, ${gridY})`);
    return { x: 0, y: 0 }; // Fallback to origin
}

function resolveCollision(player, gameMap) {
    let resolved = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 16;
    const PUSH_AMOUNT = 0.05;

    // Use a while loop to ensure the player is fully out of collision
    while (gameMap.isPixelColliding(player.pixelX, player.pixelY) && attempts < MAX_ATTEMPTS) {
        // Determine a push direction away from the tree trunk center
        const gridX = Math.floor(player.pixelX);
        const gridY = Math.floor(player.pixelY);
        
        // Find center of trunk hitbox
        const { trunkX, trunkY } = gameMap.getTrunkCenter(gridX, gridY);

        const dx = player.pixelX - trunkX;
        const dy = player.pixelY - trunkY;
        const dist = Math.sqrt(dx*dx + dy*dy);

        let pushX, pushY;

        if (dist > 0.01) {
            pushX = (dx / dist) * PUSH_AMOUNT;
            pushY = (dy / dist) * PUSH_AMOUNT;
        } else {
            // If directly on top, push in a random direction
            const randomAngle = Math.random() * 2 * Math.PI;
            pushX = Math.cos(randomAngle) * PUSH_AMOUNT;
            pushY = Math.sin(randomAngle) * PUSH_AMOUNT;
        }

        player.pixelX += pushX;
        player.pixelY += pushY;
        
        resolved = true;
        attempts++;
    }

    if(resolved) {
        console.warn(`[${player.username}] Nudged out of obstacle.`);
        // Stop current movement to prevent re-entering obstacle
        player.path = [];
        player.targetX = player.pixelX;
        player.targetY = player.pixelY;
    } else if (attempts >= MAX_ATTEMPTS) {
        // Fallback to teleport if nudging fails
        console.error(`[${player.username}] Could not nudge player out of obstacle. Teleporting to safety.`);
        const currentGridX = Math.round(player.pixelX);
        const currentGridY = Math.round(player.pixelY);
        const newPos = findNearestEmptySpot(currentGridX, currentGridY, gameMap);
        player.pixelX = newPos.x;
        player.pixelY = newPos.y;
        player.targetX = newPos.x;
        player.targetY = newPos.y;
        player.path = [];
        player.state = PLAYER_STATE.IDLE;
    }
    return resolved;
}

export class Player {
    constructor(id, username, color, gameSettings) {
        this.id = id;
        this.username = username;
        this.color = color;
        this.gameSettings = gameSettings;
        this.energy = new PlayerEnergy(this, this.gameSettings);

        // Position in grid coordinates
        this.x = 0;
        this.y = 0;

        // For smooth movement
        this.pixelX = 0;
        this.pixelY = 0;
        this.targetX = 0;
        this.targetY = 0;
        this.path = []; // Path for A* movement

        // For collision avoidance
        const angle = Math.random() * 2 * Math.PI;
        const radius = Math.random() * 0.25; // Random radius up to 25% of a tile
        this.offsetX = Math.cos(angle) * radius;
        this.offsetY = Math.sin(angle) * radius;
        
        this.isPositioned = false; // Flag to track initialization

        this.speed = 1; // tiles per second
        this.moveCooldown = 2 + Math.random() * 5; // time to wait before picking new target
        
        // Chopping state
        this.state = PLAYER_STATE.IDLE;
        this.actionTarget = null; // {x, y} of the tree, logs, etc.
        this.actionTimer = 0;
        this.actionTotalTime = 0;
        this.inventory = new PlayerInventory();
        this.pendingHarvest = []; // {x, y, type} for bushes
        this.activeCommand = null;
        this.followTargetId = null;
        this.lastSearchPosition = null; // For gathering wander logic
        this.skills = new PlayerSkills(this);
    }

    addExperience(skill, amount) {
        this.skills.addExperience(skill, amount);
    }

    setInitialPosition(gameMap) {
        if (this.isPositioned) return;
        
        const mapWidth = gameMap.width;
        const mapHeight = gameMap.height;

        let attempts = 0;
        let foundSpot = false;
        let newX, newY;

        while (attempts < 100 && !foundSpot) {
            newX = Math.floor(Math.random() * mapWidth);
            newY = Math.floor(Math.random() * mapHeight);
            
            if (!gameMap.isColliding(newX, newY)) {
                foundSpot = true;
                this.x = newX;
                this.y = newY;
                this.pixelX = newX;
                this.pixelY = newY;
                this.targetX = newX;
                this.targetY = newY;
                this.isPositioned = true;
                break;
            }
            attempts++;
        }
        
        if (!foundSpot) {
            console.warn(`Could not find a safe initial spawn point for ${this.username}. Placing at (0, 0).`);
            // Fallback: If map is full of trees, still mark as positioned
            this.isPositioned = true;
        }
    }

    addEnergy(amount = 1) {
        this.energy.add(amount);
    }

    isPowered() {
        return this.energy.isPowered();
    }

    getState() {
        return {
            id: this.id,
            username: this.username,
            color: this.color,
            energyTimestamps: this.energy.getState(),
            pixelX: this.pixelX,
            pixelY: this.pixelY,
            path: this.path,
            inventory: this.inventory.getState(),
            state: this.state,
            actionTarget: this.actionTarget, // Save the action target
            actionTimer: this.actionTimer,
            actionTotalTime: this.actionTotalTime,
            pendingHarvest: this.pendingHarvest,
            activeCommand: this.activeCommand,
            followTargetId: this.followTargetId,
            lastSearchPosition: this.lastSearchPosition,
            skills: this.skills.getState(),
            offsetX: this.offsetX,
            offsetY: this.offsetY,
        };
    }

    loadState(state) {
        if (state.pixelX !== undefined && state.pixelY !== undefined) {
            this.pixelX = state.pixelX;
            this.pixelY = state.pixelY;
            // Set target position to the loaded smooth position so movement continues from there
            this.targetX = state.pixelX;
            this.targetY = state.pixelY;
            
            this.x = Math.round(state.pixelX);
            this.y = Math.round(state.pixelY);
            this.isPositioned = true; // Loaded state implies positioned
        }
        
        this.path = state.path || [];

        // Load visual offset
        if (state.offsetX !== undefined && state.offsetY !== undefined) {
            this.offsetX = state.offsetX;
            this.offsetY = state.offsetY;
        } else {
            // Generate for older save files
            const angle = Math.random() * 2 * Math.PI;
            const radius = Math.random() * 0.25;
            this.offsetX = Math.cos(angle) * radius;
            this.offsetY = Math.sin(angle) * radius;
        }

        // Load energyTimestamps
        if (state.energyTimestamps && Array.isArray(state.energyTimestamps)) {
            this.energy.loadState(state.energyTimestamps);
        } else if (state.energy !== undefined && state.energy > 0) {
            // Handle conversion from legacy 'energy' count to timestamps.
            const timestamps = [];
            for (let i = 0; i < state.energy; i++) {
                // Assume legacy energy starts draining immediately upon load
                timestamps.push(Date.now());
            }
            this.energy.loadState(timestamps);
        }
        
        this.username = state.username || this.username;
        this.color = state.color || this.color;
        if(state.inventory) this.inventory.loadState(state.inventory);
        this.pendingHarvest = state.pendingHarvest || [];
        if(state.skills) this.skills.loadState(state.skills);
        this.activeCommand = state.activeCommand || null;
        this.followTargetId = state.followTargetId || null;
        this.lastSearchPosition = state.lastSearchPosition || null;

        this.actionTarget = state.actionTarget || null; // Restore the action target
        this.state = state.state || PLAYER_STATE.IDLE;
        this.actionTimer = state.actionTimer || 0;
        this.actionTotalTime = state.actionTotalTime || 0;
        
        // If restoring a chopping state, ensure the action target is valid.
        if (this.state === PLAYER_STATE.CHOPPING && !this.actionTarget) {
            console.warn(`[${this.username}] Restored to CHOPPING state without a valid actionTarget. Resetting to IDLE.`);
            this.state = PLAYER_STATE.IDLE;
        }

        if (this.state === PLAYER_STATE.FOLLOWING && !this.followTargetId) {
            console.warn(`[${this.username}] Restored to FOLLOWING state without a valid followTargetId. Resetting to IDLE.`);
            this.state = PLAYER_STATE.IDLE;
        }
    }

    // New method to validate state after map is loaded
    validateState(gameMap, game) {
        // Validate player position first
        const currentGridX = Math.round(this.pixelX);
        const currentGridY = Math.round(this.pixelY);

        if (
            currentGridX < 0 || currentGridX >= gameMap.width ||
            currentGridY < 0 || currentGridY >= gameMap.height ||
            gameMap.isColliding(currentGridX, currentGridY)
        ) {
            console.warn(`[${this.username}] Invalid or occupied position on load (${this.pixelX.toFixed(2)}, ${this.pixelY.toFixed(2)}). Finding nearest empty spot.`);
            
            const newPos = findNearestEmptySpot(currentGridX, currentGridY, gameMap);
            this.pixelX = newPos.x;
            this.pixelY = newPos.y;
            this.targetX = newPos.x;
            this.targetY = newPos.y;

            console.log(`[${this.username}] Relocated to (${this.pixelX.toFixed(2)}, ${this.pixelY.toFixed(2)}).`);

            // After repositioning, reset state to avoid conflicts with old invalid targets
            this.state = PLAYER_STATE.IDLE;
            this.actionTarget = null;
            this.path = [];
            return; // Exit validation early as state has been reset
        }

        const stateToTileType = {
            [PLAYER_STATE.MOVING_TO_TREE]: TILE_TYPE.TREE,
            [PLAYER_STATE.POSITIONING_TO_CHOP]: TILE_TYPE.TREE,
            [PLAYER_STATE.CHOPPING]: TILE_TYPE.TREE,
            [PLAYER_STATE.MOVING_TO_LOGS]: TILE_TYPE.LOGS,
            [PLAYER_STATE.HARVESTING_LOGS]: TILE_TYPE.LOGS,
            [PLAYER_STATE.MOVING_TO_BUSHES]: TILE_TYPE.BUSHES,
            [PLAYER_STATE.HARVESTING_BUSHES]: TILE_TYPE.BUSHES,
        };

        const requiredTileType = stateToTileType[this.state];
        
        if (requiredTileType !== undefined) {
            const target = this.actionTarget;
            const isTargetInvalid = !target || 
                                    target.y === undefined || target.x === undefined || // Check for valid object
                                    !gameMap.grid[target.y] || 
                                    gameMap.grid[target.y][target.x] !== requiredTileType;

            if (isTargetInvalid) {
                console.warn(`[${this.username}] Invalid target for state ${this.state}. Target tile at (${target?.x}, ${target?.y}) is missing or incorrect. Resetting to IDLE.`);
                this.state = PLAYER_STATE.IDLE;
                this.actionTarget = null;
                this.path = []; // Clear the path as well
            } else {
                if (this.state === PLAYER_STATE.CHOPPING) {
                    console.log(`[${this.username}] Re-initializing chopping state on load.`);
                    beginChopping(this, gameMap, game);
                } else if (this.state === PLAYER_STATE.HARVESTING_LOGS) {
                    console.log(`[${this.username}] Re-initializing harvesting logs state on load.`);
                    beginHarvestingLogs(this, gameMap, game);
                } else if (this.state === PLAYER_STATE.HARVESTING_BUSHES) {
                    console.log(`[${this.username}] Re-initializing harvesting bushes state on load.`);
                    beginHarvestingBushes(this, gameMap, game);
                }

                // Re-calculate paths for movement states
                if (this.state.startsWith('moving_to')) {
                    console.log(`[${this.username}] Re-calculating path for state ${this.state}.`);
                    const startX = Math.round(this.pixelX);
                    const startY = Math.round(this.pixelY);
                    
                    let endX = this.actionTarget.x;
                    let endY = this.actionTarget.y;
                    
                    if(this.state === PLAYER_STATE.MOVING_TO_TREE) {
                        // For trees, we path to an adjacent spot, not the tree itself.
                        // Since we don't know which adjacent spot was originally chosen,
                        // we can't perfectly reconstruct the path.
                        // Let's reset the state and let it re-path from scratch.
                        console.warn(`[${this.username}] Cannot reliably reconstruct path to tree on load. Restarting chopping cycle.`);
                        this.state = PLAYER_STATE.IDLE;
                        this.activeCommand = 'chop'; // Re-initiate the command
                        this.actionTarget = null;
                        this.path = [];
                        return;
                    }

                    const path = findPath(startX, startY, endX, endY, gameMap);
                    if (path) {
                        this.path = path;
                    } else {
                        console.warn(`[${this.username}] Path to valid target for ${this.state} is blocked. Resetting.`);
                        this.state = PLAYER_STATE.IDLE;
                        this.actionTarget = null;
                        this.path = [];
                    }
                }
            }
        }
    }

    update(deltaTime, gameMap, allPlayers, game) {
        // Apply separation from other players to prevent overlap
        applySeparation(this, allPlayers, gameMap);

        // Use pixel-based collision for nudging, which is more precise.
        if (gameMap.isPixelColliding(this.pixelX, this.pixelY)) {
            // resolveCollision will try to nudge the player out. If it succeeds,
            // it returns true, and we can skip the rest of the update for this frame.
            if(resolveCollision(this, gameMap)) {
                return;
            }
        }
        
        // This is a broader, grid-based check for being stuck in a non-traversable tile.
        // It's a fallback and should only trigger if nudging fails or in edge cases from loading a save.
        const currentGridX = Math.round(this.pixelX);
        const currentGridY = Math.round(this.pixelY);

        if (gameMap.isColliding(currentGridX, currentGridY)) {
            // Before teleporting, do one last check. A player can be at (10.4, 10.4) which rounds to (10,10),
            // but their visual position is clearly not on the tree trunk at (11, 10).
            // Only teleport if their *pixel* position is also colliding.
            if (gameMap.isPixelColliding(this.pixelX, this.pixelY)) {
                 console.warn(`[${this.username}] Detected player stuck in an obstacle tile at (${currentGridX}, ${currentGridY}) after nudge failed. Moving to safety.`);
                const newPos = findNearestEmptySpot(currentGridX, currentGridY, gameMap);
                this.pixelX = newPos.x;
                this.pixelY = newPos.y;
                this.targetX = newPos.x;
                this.targetY = newPos.y;
                this.path = [];
                this.state = PLAYER_STATE.IDLE;
                return; // Skip the rest of the update for this frame
            }
        }
        
        if (this.isPowered()) {
            const hadPower = this.energy.update(deltaTime);
            
            // If energy just ran out
            if (!hadPower) {
                this.state = PLAYER_STATE.IDLE; // Stop chopping if power runs out
                return; 
            }

            // If player is idle but has an active command, restart the task.
            if (this.state === PLAYER_STATE.IDLE && this.activeCommand) {
                if (this.activeCommand === 'chop') {
                    startChoppingCycle(this, gameMap);
                } else if (this.activeCommand === 'gather') {
                    startGatheringCycle(this, gameMap);
                } else if (this.activeCommand === 'follow') {
                    this.state = PLAYER_STATE.FOLLOWING;
                }
            }

            // State Machine for actions
            updateAction(this, deltaTime, gameMap, allPlayers, game);

        }
    }

    startChoppingCycle(gameMap) {
        startChoppingCycle(this, gameMap);
    }

    startGatheringCycle(gameMap) {
        startGatheringCycle(this, gameMap);
    }

    render(ctx, tileSize, cameraX, cameraY) {
        renderPlayer(ctx, this, tileSize, cameraX, cameraY);
    }
}