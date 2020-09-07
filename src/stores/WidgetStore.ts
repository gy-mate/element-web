/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Room } from "matrix-js-sdk/src/models/room";
import { MatrixEvent } from "matrix-js-sdk/src/models/event";

import { ActionPayload } from "../dispatcher/payloads";
import { AsyncStoreWithClient } from "./AsyncStoreWithClient";
import defaultDispatcher from "../dispatcher/dispatcher";
import SettingsStore from "../settings/SettingsStore";
import WidgetEchoStore from "../stores/WidgetEchoStore";
import WidgetUtils from "../utils/WidgetUtils";
import {IRRELEVANT_ROOM} from "../settings/WatchManager";
import {SettingLevel} from "../settings/SettingLevel";

interface IState {}

export interface IApp {
    id: string;
    type: string;
    roomId: string;
    eventId: string;
    creatorUserId: string;
    waitForIframeLoad?: boolean;
    // eslint-disable-next-line camelcase
    avatar_url: string; // MSC2765 https://github.com/matrix-org/matrix-doc/pull/2765
}

interface IRoomWidgets {
    widgets: IApp[];
    pinned: Set<string>;
}

// TODO consolidate WidgetEchoStore into this
// TODO consolidate ActiveWidgetStore into this
export class WidgetStore extends AsyncStoreWithClient<IState> {
    private static internalInstance = new WidgetStore();

    private widgetMap = new Map<string, IApp>();
    private roomMap = new Map<string, IRoomWidgets>();

    private constructor() {
        super(defaultDispatcher, {});

        SettingsStore.watchSetting("Widgets.pinned", IRRELEVANT_ROOM, this.onPinnedWidgetsChange);
        WidgetEchoStore.on("update", this.onWidgetEchoStoreUpdate);
    }

    public static get instance(): WidgetStore {
        return WidgetStore.internalInstance;
    }

    private initRoom(roomId: string) {
        if (!this.roomMap.has(roomId)) {
            this.roomMap.set(roomId, {
                pinned: new Set(),
                widgets: [],
            });
        }
    }

    protected async onReady(): Promise<any> {
        this.matrixClient.on("RoomState.events", this.onRoomStateEvents);
        this.matrixClient.getRooms().forEach((room: Room) => {
            const pinned = SettingsStore.getValue("Widgets.pinned", room.roomId);

            if (pinned || WidgetUtils.getRoomWidgets(room).length) {
                this.initRoom(room.roomId);
            }

            if (pinned) {
                this.getRoom(room.roomId).pinned = new Set(pinned);
            }

            this.loadRoomWidgets(room);
        });
        this.emit("update");
    }

    protected async onNotReady(): Promise<any> {
        this.matrixClient.off("RoomState.events", this.onRoomStateEvents);
        this.widgetMap = new Map();
        this.roomMap = new Map();
        await this.reset({});
    }

    // We don't need this, but our contract says we do.
    protected async onAction(payload: ActionPayload) {
        return;
    }

    private onWidgetEchoStoreUpdate(roomId: string, widgetId: string) {
        this.initRoom(roomId);
        this.loadRoomWidgets(this.matrixClient.getRoom(roomId));
        this.emit("update");
    }

    private generateApps(room: Room): IApp[] {
        return WidgetEchoStore.getEchoedRoomWidgets(room.roomId, WidgetUtils.getRoomWidgets(room)).map((ev) => {
            return WidgetUtils.makeAppConfig(
                ev.getStateKey(), ev.getContent(), ev.getSender(), ev.getRoomId(), ev.getId(),
            );
        });
    }

    private loadRoomWidgets(room: Room) {
        const roomInfo = this.roomMap.get(room.roomId);
        roomInfo.widgets = [];
        this.generateApps(room).forEach(app => {
            this.widgetMap.set(app.id, app);
            roomInfo.widgets.push(app);
        });
        this.emit(room.roomId);
    }

    private onRoomStateEvents(ev: MatrixEvent) {
        if (ev.getType() !== "im.vector.modular.widgets") return;
        const roomId = ev.getRoomId();
        this.initRoom(roomId);
        this.loadRoomWidgets(this.matrixClient.getRoom(roomId));
        this.emit("update");
    }

    public getRoomId = (widgetId: string) => {
        const app = this.widgetMap.get(widgetId);
        if (!app) return null;
        return app.roomId;
    }

    public getRoom = (roomId: string) => {
        return this.roomMap.get(roomId);
    };

    private onPinnedWidgetsChange = (settingName: string, roomId: string) => {
        const pinned = SettingsStore.getValue(settingName, roomId);
        this.initRoom(roomId);
        this.getRoom(roomId).pinned = new Set(pinned);
        this.emit(roomId);
        this.emit("update");
    };

    public isPinned(widgetId: string) {
        const roomId = this.getRoomId(widgetId);
        const roomInfo = this.getRoom(roomId);
        // TODO heuristic for Jitsi etc
        return roomInfo ? roomInfo.pinned.has(widgetId) : false;
    }

    public pinWidget(widgetId: string) {
        const roomId = this.getRoomId(widgetId);
        const roomInfo = this.getRoom(roomId);
        if (!roomInfo) return;
        roomInfo.pinned.add(widgetId);
        SettingsStore.setValue("Widgets.pinned", roomId, SettingLevel.ROOM_ACCOUNT, Array.from(roomInfo.pinned));
        this.emit(roomId);
        this.emit("update");
    }

    public unpinWidget(widgetId: string) {
        const roomId = this.getRoomId(widgetId);
        const roomInfo = this.getRoom(roomId);
        if (!roomInfo) return;
        roomInfo.pinned.delete(widgetId);
        SettingsStore.setValue("Widgets.pinned", roomId, SettingLevel.ROOM_ACCOUNT, Array.from(roomInfo.pinned));
        this.emit(roomId);
        this.emit("update");
    }

    public getApps(room: Room, pinned?: boolean): IApp[] {
        const apps = this.getRoom(room.roomId).widgets;
        if (pinned) {
            return apps.filter(app => this.isPinned(app.id));
        }
        return apps
    }
}

window.mxWidgetStore = WidgetStore.instance;
