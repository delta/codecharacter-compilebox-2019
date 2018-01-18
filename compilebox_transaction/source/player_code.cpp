#include "player_code/player_code.h"
#include <iostream>

namespace player_code {

PlayerCode::PlayerCode(state::PlayerState *player_state)
    : player_state(player_state) {}

void PlayerCode::Update() { std::cout<<"Hello World!\n"; }
}